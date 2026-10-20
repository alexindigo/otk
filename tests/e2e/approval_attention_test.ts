// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  hideNotifications,
  instrumentNotifications,
} from "../support/notification-browser.ts";

Deno.test("U9 r2 browser-open automatic permission stays quiet through toast OS takeover and attention consumers; reply and accessible policy reach the end", async () => {
  const f = await browserFixture();
  let release!: () => void, replying = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: freePort(),
    onListen() {},
  }, async (request) => {
    const url = new URL(request.url);
    if (/\/permission\/[^/]+\/reply$/.test(url.pathname)) {
      replying = true;
      await held;
      if (request.signal.aborted) return new Response(null, { status: 499 });
    }
    url.port = String(f.oc.port);
    return await fetch(new Request(url, request));
  });
  let client: WsClient | undefined, restore: (() => Promise<void>) | undefined;
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Quiet automatic session" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Manual observer" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}`, db: f.oc.db },
    });
    const b = await f.browser(server.url),
      observer = await f.browser(server.url);
    await instrumentNotifications(observer);
    await observer.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["notifications"],
    });
    await observer.reload();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await client.rpc("prefs.set", { key: "notify.os", value: true });
    await openSession(b, root.id);
    await openSession(observer, other.id);
    await b.click(".otk-auto-approve-toggle");
    await b.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='true'",
    );
    await observer.poll("!!document.querySelector('.otk-auto-mark')");
    const ax = async (label: string) => {
      const tree = await b.send("Accessibility.getFullAXTree");
      const nodes = tree.nodes as {
        role?: { value: string };
        name?: { value: string };
      }[];
      assert(
        nodes.some((n) =>
          n.role?.value === "tab" && n.name?.value.includes(label)
        ),
        `Tab accessible name includes ${label}`,
      );
      assert(
        nodes.some((n) =>
          n.role?.value === "button" &&
          n.name?.value === "Quiet automatic session, Auto-approve on"
        ),
        "Breadcrumb accessible name includes policy",
      );
    };
    await ax("Quiet automatic session, Auto-approve on");
    for (const browser of [b, observer]) {
      await browser.evaluate(`(() => {
        globalThis.autoAttentionEvidence=[];
        const inspect=()=>{
          for(const e of document.querySelectorAll('.otk-permission-dock,.otk-toast,.otk-status-light[data-state=blocked]')) {
            if(e.matches('.otk-permission-dock,.otk-status-light[data-state=blocked]')||e.textContent.includes('Permission needed')) autoAttentionEvidence.push(e.textContent);
          }
        };
        new MutationObserver(inspect).observe(document.body,{subtree:true,childList:true,characterData:true});inspect();
      })()`);
    }
    restore = await hideNotifications(observer);
    const command = "printf quiet-auto > quiet-auto.txt; printf quiet-auto";
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command, description: "Quiet automatic approval" },
      },
    }, { chunks: ["Quiet automatic reply completed"] });
    await b.type("textarea[name=prompt]", "Run quiet automatic command");
    await b.key("Enter");
    await waitFor(() => replying, Boolean);
    await b.poll(
      "document.querySelector('.otk-auto-approving')?.textContent==='Auto-approving…' && !document.querySelector('.otk-permission-dock') && document.querySelector('.otk-composer')?.hidden===false",
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('.otk-status-light[data-state=blocked]')",
      ),
      false,
    );
    const shots = Deno.env.get("OTK_AUTO_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [theme, suffix] of [["otk-dark", "dark"], ["otk-light", "light"]]
      ) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await b.screenshot(join(shots, `quiet-pending-${suffix}.png`));
      }
    }
    release();
    await waitForReply(b, root.id, "Quiet automatic reply completed");
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "quiet-auto.txt")),
      "quiet-auto",
    );
    for (const browser of [b, observer]) {
      assertEquals(
        await browser.evaluate("autoAttentionEvidence"),
        [],
        "No transient permission toast or takeover at any observed mutation",
      );
      assertEquals(
        sentFrames(browser).filter(({ frame }) =>
          frame.method === "permission.reply"
        ),
        [],
        "No racing browser action",
      );
    }
    assertEquals(
      await observer.evaluate(
        "notificationEvidence.notes.filter(n=>n.title==='Permission needed').length",
      ),
      0,
    );
    const history = await client.rpc("permission.activity", {
      sessionID: root.id,
    }) as { entries: { outcome: string; source: string }[] };
    assertEquals(history.entries.map((r) => [r.source, r.outcome]), [[
      "auto",
      "confirmed",
    ]]);
    // Actual send promotes the preview to a task: both tab concepts name policy.
    await ax("Auto-approve is on for a session in this task");
    await b.click('[data-panel-view="activity"]');
    await b.poll(
      "document.querySelector('.otk-permission-activity')?.textContent.includes('quiet-auto.txt')",
    );
    if (shots) {
      for (
        const [theme, suffix] of [["otk-dark", "dark"], ["otk-light", "light"]]
      ) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await b.screenshot(join(shots, `quiet-recorded-${suffix}.png`));
      }
    }
    const reads = sentFrames(b).filter(({ frame }) =>
      frame.method === "permission.activity"
    ).length;
    await client.rpc("permission.auto", { sessionID: other.id, enabled: true });
    await observer.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='true'",
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) =>
        frame.method === "permission.activity"
      ).length,
      reads,
    );
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf other-auto > other-auto.txt",
          description: "Unrelated activity",
        },
      },
    }, { chunks: ["Other complete"] });
    await client.rpc("session.prompt", {
      sessionID: other.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Run unrelated automatic command" }],
    });
    await waitFor(() =>
      Deno.readTextFile(join(f.oc.directory, "other-auto.txt")), (value) =>
      value === "other-auto");
    await waitFor(() =>
      f.oc.request<Record<string, unknown>>("/session/status"), (value) =>
      !value[other.id]);
    const otherHistory = await client.rpc("permission.activity", {
      sessionID: other.id,
    }) as { entries: { outcome: string }[] };
    assertEquals(otherHistory.entries[0].outcome, "confirmed");
    assertEquals(
      sentFrames(b).filter(({ frame }) =>
        frame.method === "permission.activity"
      ).length,
      reads,
      "Unrelated confirmed activity never refreshes selected family",
    );
  } finally {
    release();
    await restore?.();
    await client?.close();
    await f.stop();
    await proxy.shutdown();
  }
});
