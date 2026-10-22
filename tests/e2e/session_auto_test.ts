// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import type { PermissionRequest } from "@otk/protocol";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";

test("U9 footer auto-approve, command, inherited marks and persisted activity reach browser consumers; dirty permission input is guarded", async () => {
  const f = await browserFixture();
  const proxy = new FreezeProxy(f.oc.port);
  let client: WsClient | undefined;
  const shots = Deno.env.get("OTK_AUTO_SHOTS");
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Session auto-approve" },
    });
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Inherited helper", parentID: root.id },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Manual session" },
    });
    const server = await f.sidecar({
        harness: { url: `http://127.0.0.1:${proxy.port}`, db: f.oc.db },
      }),
      b = await f.browser(server.url),
      second = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await client.rpc("prefs.set", { key: "showCost", value: false });
    await openSession(b, root.id);
    await openSession(second, root.id);
    await b.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='false'",
    );
    assert(
      await b.evaluate(
        "(()=>{const e=document.querySelector('.otk-auto-approve-toggle'),r=e.getBoundingClientRect();return e.getAttribute('aria-label')==='Auto-approve'&&r.width===28&&r.height===28&&!!e.querySelector('svg')})()",
      ),
    );
    const capture = async (name: string) => {
      if (!shots) return;
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [theme, suffix] of [["otk-dark", "dark"], ["otk-light", "light"]]
      ) {
        await client!.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await b.screenshot(join(shots, `${name}-${suffix}.png`));
      }
    };
    await capture("off");
    await b.click(".otk-auto-approve-toggle");
    const on =
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='true'";
    await b.poll(on);
    await second.poll(on);
    await b.poll(
      `!!document.querySelector('[data-session="${root.id}"] .otk-auto-mark') && !!document.querySelector('[data-session="${child.id}"] .otk-auto-mark') && !!document.querySelector('[data-tab="${root.id}"] .otk-auto-mark')`,
    );
    assertEquals(
      await b.evaluate(
        `!!document.querySelector('[data-session="${other.id}"] .otk-auto-mark')`,
      ),
      false,
    );
    assert(
      await b.evaluate(
        `(()=>{const r=document.querySelector('[data-session="${root.id}"]'),m=r.querySelector('.otk-auto-mark'),t=r.querySelector('.otk-row-title'),a=m.getBoundingClientRect(),v=t.getBoundingClientRect();return Math.abs(a.y+a.height/2-v.y-v.height/2)<.5 && a.width>0 && getComputedStyle(m).position==='static'})()`,
      ),
    );
    await capture("on");
    await openSession(second, other.id);
    await second.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='false'",
    );
    const command =
      "printf browser-auto > browser-auto.txt; printf browser-auto";
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command, description: "Browser auto reply" },
      },
    }, { chunks: ["Automatic browser reply finished"] });
    await b.type(
      "textarea[name=prompt]",
      "Run the automatically approved command",
    );
    await b.key("Enter");
    await waitForReply(b, root.id, "Automatic browser reply finished");
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "browser-auto.txt")),
      "browser-auto",
    );
    await b.click('[data-panel-view="activity"]');
    await b.poll(
      `document.querySelector('.otk-permission-activity')?.textContent.includes(${
        JSON.stringify(command)
      }) && document.querySelector('.otk-permission-activity')?.textContent.includes('Allowed')`,
    );
    assert(
      await b.evaluate(
        "document.querySelector('.otk-permission-activity').textContent.includes('Auto')",
      ),
    );
    const activityReads = () =>
      sentFrames(b).filter(({ frame }) =>
        frame.method === "permission.activity"
      ).length;
    assertEquals(
      activityReads(),
      1,
      "One selected Activity consumer makes one initial resource read",
    );
    await b.poll(
      "!document.querySelector('.otk-permission-activity [role=status]')",
    );
    await capture("activity");
    assertEquals(
      activityReads(),
      1,
      "Settled rendering and unrelated theme broadcasts do not refetch Activity",
    );
    await b.click(`[data-crumb="${child.id}"]`);
    await b.poll(
      `location.hash.endsWith('/${child.id}') && document.querySelector('.otk-permission-activity')?.textContent.includes('Permission replies will appear here.') && !document.querySelector('.otk-permission-activity [data-activity]')`,
    );
    await b.poll(
      "!!document.querySelector('.otk-subagent-bar') && ![...document.querySelectorAll('.otk-messages > p')].some(e=>e.textContent==='Loading messages…')",
    );
    await capture("helper-activity");
    await b.click(`[data-crumb="${root.id}"]`);
    await b.poll(
      `location.hash.endsWith('/${root.id}') && document.querySelector('.otk-permission-activity')?.textContent.includes('browser-auto.txt') && !document.querySelector('.otk-permission-activity [role=status]')`,
    );
    await b.reload();
    await b.poll(on);
    await b.poll(
      "document.querySelector('.otk-permission-activity')?.textContent.includes('browser-auto.txt')",
    );
    await b.key("A", 10);
    await b.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='false'",
    );
    assert(
      sentFrames(b).some(({ frame }) =>
        frame.method === "permission.auto" &&
        (frame.params as { enabled: boolean }).enabled === false
      ),
      "Page-delivered Mod+Shift+A invokes the command; native browser-chrome interception is outside CDP's proof",
    );
    const dirtyCommand =
      "printf guarded-auto > guarded-auto.txt; printf guarded-auto";
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: dirtyCommand,
          description: "Guard unsaved permission work",
        },
      },
    }, { chunks: ["Guarded auto reply finished"] });
    await b.type("textarea[name=prompt]", "Wait for manual input first");
    await b.key("Enter");
    await b.poll(
      "!!document.querySelector('.otk-permission-dock .otk-rejection-reason')",
    );
    await b.type(
      ".otk-rejection-reason",
      "Keep my unsaved permission feedback",
    );
    const palette = async () => {
      await b.key("k", 2);
      await b.poll("!!document.querySelector('input[name=command-search]')");
      await b.fill("input[name=command-search]", "Toggle session auto-approve");
      await b.poll(
        "!!document.querySelector('[data-command=\"permission.auto\"]:not(:disabled)')",
      );
    };
    await palette();
    await b.dialog(() => b.click('[data-command="permission.auto"]'), false);
    await b.poll("!document.querySelector('dialog')");
    assertEquals(
      await b.evaluate("document.querySelector('.otk-rejection-reason').value"),
      "Keep my unsaved permission feedback",
    );
    assertEquals(
      await Deno.stat(join(f.oc.directory, "guarded-auto.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    await capture("dirty-cancelled");
    await palette();
    await b.dialog(() => b.click('[data-command="permission.auto"]'), true);
    await b.poll(
      "!document.querySelector('dialog') && !document.querySelector('.otk-permission-dock')",
    );
    await waitFor(
      () => Deno.readTextFile(join(f.oc.directory, "guarded-auto.txt")),
      (text) => text === "guarded-auto",
    );
    await b.poll(on);
    await b.poll(
      "document.querySelectorAll('.otk-permission-activity [data-activity]').length===2",
    );
    await waitFor(
      () => f.oc.request<Record<string, unknown>>("/session/status"),
      (state) => !state[root.id],
    );
    await b.poll(
      "[...document.querySelectorAll('[data-role=assistant] .otk-text')].some(e=>e.textContent==='Guarded auto reply finished') && [...document.querySelectorAll('.otk-message-footer')].every(e=>!e.textContent.includes('streaming'))",
    );
    await b.poll(
      "!document.querySelector('.otk-permission-activity [role=status]')",
    );
    await capture("activity-two");
    const disconnectedAt = client.frames.length;
    proxy.freeze();
    await waitFor(
      () => client!.frames.slice(disconnectedAt),
      (frames) =>
        frames.some((frame) =>
          frame.t === "harness" && frame.state !== "connected"
        ),
      60_000,
    );
    await b.click(".otk-auto-approve-toggle");
    await b.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='false'",
    );
    await b.poll(
      "document.querySelectorAll('.otk-permission-activity [data-activity]').length===2 && !document.querySelector('.otk-permission-activity [role=alert]') && !document.querySelector('.otk-permission-activity [role=status]')",
    );
    await capture("offline-off");
    const reconnectedAt = client.frames.length;
    proxy.thaw();
    await waitFor(
      () => client!.frames.slice(reconnectedAt),
      (frames) =>
        frames.some((frame) =>
          frame.t === "harness" && frame.state === "connected"
        ),
      60_000,
    );
    const manualCommand = "printf manual-ui > manual-ui.txt; printf manual-ui";
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: manualCommand, description: "Manual activity proof" },
      },
    }, { chunks: ["Manual browser reply finished"] });
    await b.type(
      "textarea[name=prompt]",
      "Record a manual reply in the same activity view",
    );
    await b.key("Enter");
    await b.poll(
      "document.querySelector('.otk-permission-command')?.textContent.includes('manual-ui')",
    );
    await b.click(".otk-permission-actions .otk-primary");
    await waitFor(
      () => Deno.readTextFile(join(f.oc.directory, "manual-ui.txt")),
      (text) => text === "manual-ui",
    );
    await waitFor(
      () => f.oc.request<Record<string, unknown>>("/session/status"),
      (state) => !state[root.id],
    );
    await b.poll(
      "document.querySelectorAll('.otk-permission-activity [data-activity]').length===3 && document.querySelector('.otk-permission-activity').textContent.includes('Manual') && !document.querySelector('.otk-permission-activity [role=status]')",
    );
    await capture("activity-manual");
    // Persist the same failed/interrupted states proven by the held-ack core
    // tests, then observe their actual RPC/browser presentation after reload.
    const history = new OtkDb(join(f.oc.root, `otk-${server.port}`), [
      permissionMigrations,
    ]);
    try {
      const records = new PermissionStore(history);
      for (
        const [id, error] of [[
          "failed-display-fixture",
          "Stored failure fixture",
        ], ["unconfirmed-display-fixture", undefined]] as const
      ) {
        const request: PermissionRequest = {
          id,
          sessionID: root.id,
          kind: "bash",
          title: "bash",
          patterns: [`printf ${id}`],
          alwaysPatterns: [],
          time: Date.now(),
          detail: { kind: "bash", command: `printf ${id}` },
        };
        const record = records.start({
          session: root.id,
          requestID: id,
          request: JSON.stringify(request),
          reply: "once",
          source: "auto",
          owner: root.id,
        });
        if (error) records.finish(record, { outcome: "failed", error });
      }
    } finally {
      history.close();
    }
    await b.reload();
    await b.poll(
      "document.querySelectorAll('.otk-permission-activity [data-activity]').length===5 && document.querySelector('.otk-permission-activity .otk-error')?.textContent.includes('Stored failure fixture') && document.querySelector('.otk-permission-activity')?.textContent.includes('Reply started; outcome not confirmed') && !document.querySelector('.otk-permission-activity [role=status]')",
    );
    assert(
      await b.evaluate(
        "(()=>{const e=document.querySelector('.otk-permission-activity'),r=e.getBoundingClientRect(),p=document.querySelector('.otk-right-panel').getBoundingClientRect(),heading=document.querySelector('.otk-panel-content > h2').getBoundingClientRect(),row=e.querySelector('header').getBoundingClientRect();return e.scrollHeight>e.clientHeight&&getComputedStyle(e).overflowY==='auto'&&r.bottom<=p.bottom+.5&&p.width===320&&Math.abs(heading.left-row.left)<.5&&document.scrollingElement.scrollHeight===innerHeight&&document.scrollingElement.scrollWidth===innerWidth})()",
      ),
      "Activity owns long-list scrolling and the shared heading gutter without resizing or scrolling the document",
    );
    await capture("activity-outcomes");
    const point = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.otk-permission-activity').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: 350,
    });
    await b.poll(
      "document.querySelector('.otk-permission-activity').scrollTop>0 && document.scrollingElement.scrollTop===0",
    );
    await capture("activity-scrolled");
    console.info(
      "U9 shortcut proof is page-delivered trusted CDP input; footer and palette remain primary browser-independent controls",
    );
  } finally {
    await client?.close();
    await proxy.stop();
    await f.stop();
  }
});
