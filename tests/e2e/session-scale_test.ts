// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { SCALE, SessionScale } from "../support/session-scale.ts";
import {
  sentFrames,
  waitForCollapsedPanels,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { sessionFamily, usageCost } from "@otk/client";
import type { PermissionRequest } from "@otk/protocol";
import { menuReady } from "../support/menu.ts";
import { wheelViewport } from "../support/message-viewport.ts";

const viewport = ".otk-project-session-tree";
const search = '[aria-label="Search sessions by title"]';
const framesAhead =
  "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))";
// Five default overscan rows on either side, plus two viewport-edge rows.
const WINDOW_EXTRA_ROWS = 2 * 5 + 2;
function assertScopedWarming(
  calls: ReturnType<typeof sentFrames>[number]["frame"][],
  selected: string,
  members: ReadonlySet<string>,
  attention: ReadonlySet<string> = new Set(),
) {
  const reads = new Map<string, unknown[]>();
  for (const frame of calls) {
    const params = frame.params as
      | { sessionID?: string; before?: string }
      | undefined;
    const id = params?.sessionID;
    if (!id || id === selected) continue;
    if (frame.method === "permission.list" && attention.has(id)) continue;
    assertEquals(
      frame.method,
      "session.messages",
      "Nonselected rows admit no model, point or detail demand",
    );
    assert(
      members.has(id),
      `Body demand escaped the active/attention scopes: ${id}`,
    );
    assertEquals(
      Object.keys(params!).sort(),
      params?.before ? ["before", "sessionID"] : ["sessionID"],
    );
    const cursors = reads.get(id) ?? [];
    cursors.push(params?.before);
    reads.set(id, cursors);
  }
  for (const [id, cursors] of reads) {
    assert(
      cursors.length <= 2,
      `Only newest10 + reserve10 warm ${id}: ${JSON.stringify(cursors)}`,
    );
    assertEquals(cursors[0], undefined);
    if (cursors.length === 2) {
      assert(typeof cursors[1] === "string" && !!cursors[1]);
    }
  }
}
async function visibleLight(browser: Cdp, selector: string) {
  await browser.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
  assert(
    await browser.evaluate(
      `(()=>{const r=document.querySelector(${
        JSON.stringify(selector)
      }).getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`,
    ),
    selector,
  );
}
async function openContext(browser: Cdp, selector: string) {
  const point = await browser.evaluate<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector(${
      JSON.stringify(selector)
    }).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await browser.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      buttons: type === "mousePressed" ? 2 : 0,
      clickCount: 1,
    });
  }
  const menu = ':popover-open [role=menu][aria-label="Context menu"]';
  await menuReady(browser, menu);
  return menu;
}
async function windowBound(browser: Cdp, pins = 0) {
  const result = await browser.evaluate<{ count: number; bound: number }>(
    `(()=>{const v=document.querySelector('${viewport}'),rows=[...v.querySelectorAll('.otk-session-row')],height=Math.min(...rows.map(row=>row.getBoundingClientRect().height));return {count:rows.length,bound:Math.ceil(v.clientHeight/height)+${WINDOW_EXTRA_ROWS}+${pins}}})()`,
  );
  assert(
    result.count > 0 && result.count <= result.bound,
    JSON.stringify(result),
  );
  return result;
}
const anchorProbe =
  `(()=>{const v=document.querySelector('${viewport}'),r=v.getBoundingClientRect(),e=[...v.querySelectorAll('[data-virtual-key]')].find(e=>e.getBoundingClientRect().bottom>r.top+.5);return {key:e.dataset.virtualKey,offset:e.getBoundingClientRect().top-r.top}})()`;

for (const theme of ["otk-dark", "otk-light"]) {
  test(`real native scale paints cold and warm windows and completes interactive work in ${theme}`, async () => {
    const root = await tempDir("sb-"), fake = new FakeLlm();
    const f = await SessionScale.create(join(root, "fixture"), root, fake);
    await Deno.writeTextFile(
      join(root, "scale-manifest.json"),
      JSON.stringify(f.manifest),
    );
    const config = cfg();
    config.server.port = freePort();
    config.auth.type = "none";
    config.state.path = join(root, "otk");
    config.harness.url = f.url;
    config.harness.db = f.db;
    const app = await start(config);
    resources().defer("scale application", () => app.stop());
    const ready = new Set<string>();
    const nativeEvents: {
      id: string;
      status: string;
      attention: number;
      wall: number;
    }[] = [];
    for (const entry of app.index.values()) {
      if (entry.digest.state === "ready") ready.add(entry.id);
    }
    resources().defer(
      "scale index observation",
      app.index.observe((entry, previous) => {
        if (entry.digest.state === "ready") ready.add(entry.id);
        else ready.delete(entry.id);
        if (
          previous &&
          (previous.status !== entry.status ||
            JSON.stringify(previous.attention) !==
              JSON.stringify(entry.attention))
        ) {
          nativeEvents.push({
            id: entry.id,
            status: entry.status,
            attention: entry.attention.permissions + entry.attention.questions +
              entry.attention.childPermissions + entry.attention.childQuestions,
            wall: Date.now(),
          });
        }
      }),
    );
    const url = `http://127.0.0.1:${config.server.port}`;
    const c = new WsClient(url);
    await c.connect();
    await waitFor(
      () => app.index.get(f.manifest.sessions.at(-1)!.id),
      Boolean,
      120000,
    );
    await c.rpc("prefs.set", { key: "theme", value: theme });
    await c.rpc("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    const groupedTask = await c.rpc<{ id: string }>("tasks.create", {
      directory: f.directory,
      name: "Scale grouped work",
      sessions: [f.manifest.sessions[0].id, f.manifest.sessions[4].id],
    });
    const b = await Cdp.launch(root), selected = f.manifest.sessions[0];
    const browserRuns: unknown[] = [];
    const observations: Record<string, unknown> = {};
    const shots = Deno.env.get("OTK_SCALE_SCREENSHOTS");
    const capture = async (name: string) => {
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.screenshot(join(shots, `${theme}-${name}.png`));
      }
    };
    // Installed before navigation: receipt time and first post-geometry paint are
    // measured in the browser clock, not inferred from a later CDP round trip.
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
      const Native=WebSocket,titles=new Set(${
        JSON.stringify([
          ...f.manifest.sessions.slice(0, SCALE.projectSessions).map((row) =>
            row.title
          ),
          "Scale interactive outcome",
        ])
      }); globalThis.scale={snapshots:[],calls:[],cancels:[],results:[],paints:[]};
      globalThis.WebSocket=class extends Native {
        constructor(...args){super(...args);this.addEventListener('message',event=>{
          const f=JSON.parse(event.data),at=performance.now();
          if(f.t==='rpc.result')scale.results.push({at,wall:Date.now(),...f});
          if(f.t!=='index.snapshot'||f.entries.length<${SCALE.sessions}||!location.hash.endsWith('/${selected.id}'))return;
          const snapshot={at,ready:f.entries.every(e=>e.digest.state==='ready')};scale.snapshots.push(snapshot);
          const paint=()=>{const rows=[...document.querySelectorAll('.otk-session-row')],v=document.querySelector('${viewport}');
            const chosen=document.querySelector('[data-session="${selected.id}"]');
            const boxes=rows.map(row=>row.getBoundingClientRect()),bound=v?Math.ceil(v.clientHeight/Math.min(...boxes.map(r=>r.height)))+${WINDOW_EXTRA_ROWS}:0;
            const valid=rows.length>0&&rows.length<=bound&&v&&chosen?.getAttribute('aria-current')==='page'&&rows.every((row,i)=>boxes[i].width>0&&boxes[i].height>0&&row.querySelector('.otk-status-light')&&titles.has(row.querySelector('.otk-row-title')?.textContent));
            if(valid)scale.paints.push({snapshot,at:performance.now(),elapsed:performance.now()-at,rows:rows.length,bound});else requestAnimationFrame(paint);
          };requestAnimationFrame(paint);
        });}
        send(data){const f=JSON.parse(data);if(f.t==='rpc')scale.calls.push({at:performance.now(),wall:Date.now(),...f});if(f.t==='rpc.cancel')scale.cancels.push({at:performance.now(),...f});super.send(data);}
      };
    })()`,
    });
    resources().evidence("scale browser evidence", async () => {
      await Deno.writeTextFile(
        join(root, "scale-browser.json"),
        JSON.stringify(
          {
            theme,
            nativeEvents,
            observations,
            runs: [...browserRuns, await b.evaluate("globalThis.scale")],
            errors: b.errors,
            html: await b.evaluate("document.documentElement.outerHTML"),
          },
          null,
          2,
        ),
      );
    });
    await b.goto(`${url}/#/local/${selected.id}`);
    await b.poll("globalThis.scale?.paints.length>0", 120000);
    const cold = await b.evaluate<
      {
        elapsed: number;
        rows: number;
        bound: number;
        snapshot: { ready: boolean };
      }
    >("scale.paints[0]");
    console.info("Scale cold paint", theme, cold);
    observations.cold = cold;
    console.info("Session scale cold paint (ms)", cold.elapsed);
    assertEquals(
      cold.snapshot.ready,
      false,
      "First backfill must be observed while digesting",
    );
    const coldCalls = sentFrames(b).map((event) => event.frame).filter(
      (frame) => frame.t === "rpc",
    );
    assertEquals(coldCalls.filter((frame) => frame.method === "usage.get"), []);
    const taskRoots = new Set([selected.id, f.manifest.sessions[4].id]);
    const taskMembers = new Set(
      f.manifest.sessions.filter((row) =>
        sessionFamily(row.id, (id) => app.index.get(id)).some((id) =>
          taskRoots.has(id)
        )
      ).map((row) => row.id),
    );
    assertScopedWarming(coldCalls, selected.id, taskMembers);
    await capture("cold-digesting");
    const actionsStart = performance.now();
    await b.click(".otk-task-new");
    await b.poll("!!document.querySelector('input[name=taskName]')");
    await b.fill("input[name=taskName]", "Scale pending task");
    await b.click("dialog button[type=submit]");
    await b.poll(
      "!document.querySelector('dialog') && document.querySelector('.otk-project-tabs')?.textContent.includes('Scale pending task')",
    );
    const actionTask =
      (await c.rpc<{ id: string; name: string }[]>("tasks.list", {})).find(
        (task) => task.name === "Scale pending task",
      )!;
    assert(actionTask, "Browser task creation must be committed");
    const menu = await openContext(b, `[data-tab="${actionTask.id}"]`);
    await b.click(`${menu} [data-context-command^="task.rename:"]`);
    await b.poll(
      "!!document.querySelector('dialog[aria-label=\"Rename task\"][open]')",
    );
    await b.fill("input[name=taskName]", "Scale saved task");
    await b.click("dialog button[type=submit]");
    await b.poll(
      "document.querySelector('.otk-project-tabs')?.textContent.includes('Scale saved task')",
    );
    assertEquals(
      (await c.rpc<{ id: string; name: string }[]>("tasks.list", {})).find(
        (task) => task.id === actionTask.id,
      )?.name,
      "Scale saved task",
    );
    // Use a new native session for actual prompt/approval/interrupt, while the
    // large project remains selected and background digestion is active.
    const live = await f.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Scale interactive outcome" },
    });
    // Exercise the actual browser RPC implementation, including its failure
    // presentation, rather than the raw fixture client's independent timeout.
    await b.fill(search, "Scale interactive outcome");
    await b.poll(
      `!!document.querySelector('[data-session="opcv1-${live.id}"]')`,
    );
    await b.click(`[data-session="opcv1-${live.id}"]`);
    await b.poll("!!document.querySelector('textarea[name=prompt]')");
    const hold = fake.queueHeld({ chunks: ["Scale accepted reply"] });
    await b.fill("textarea[name=prompt]", "Scale interactive prompt");
    await b.key("Enter");
    await waitFor(
      () => app.index.get(`opcv1-${live.id}`)?.status,
      (status) => status === "busy",
    );
    await b.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('Scale accepted reply')",
    );
    await b.key("Escape");
    await b.key("Escape");
    await waitFor(
      () => app.index.get(`opcv1-${live.id}`)?.status,
      (s) => s === "idle",
    );
    hold.release();
    fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf scale_approved",
          description: "Scale approval",
        },
      },
    }, { chunks: ["Scale approval confirmed"] });
    await b.fill("textarea[name=prompt]", "Approval during scale backfill");
    await b.key("Enter");
    await b.poll("!!document.querySelector('.otk-permission-dock')");
    await b.click(".otk-permission-actions > button:first-child");
    await b.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('Scale approval confirmed') && !document.querySelector('.otk-permission-dock')",
    );
    await waitFor(
      () => app.index.get(`opcv1-${live.id}`)?.status,
      (status) => status === "idle",
    );
    const failed = await b.evaluate<unknown[]>(
      "scale.results.filter(f=>f.ok===false && !scale.cancels.some(c=>c.id===f.id && c.at<=f.at))",
    );
    assertEquals(failed, [], "No active request may be presented as failed");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('[role=alert]')].some(e=>/timed out|aborted due to timeout/i.test(e.textContent))",
      ),
      false,
    );
    console.info(
      "Scale interactive saved/interrupt outcomes ms",
      performance.now() - actionsStart,
    );
    // Real native activity in another project remains visible independently of
    // list filtering, viewport demand and the lifetime of both side panels.
    const background = f.manifest.sessions[251].directory;
    const createBackground = async (title: string) => {
      const session = await f.request<{ id: string }>("/session", {
        method: "POST",
        directory: background,
        body: { title },
      });
      return { native: session.id, id: `opcv1-${session.id}` };
    };
    const beginBackground = (session: { native: string }, text: string) =>
      f.request(`/session/${session.native}/prompt_async`, {
        method: "POST",
        directory: background,
        body: {
          model: { providerID: "fake", modelID: "scripted" },
          parts: [{ type: "text", text }],
        },
      });
    const providerSaw = (text: string) =>
      fake.requests.some((request) => {
        const body = JSON.stringify(request);
        return body.includes(text) &&
          !body.includes("Generate a title for this conversation:");
      });
    const finished = await createBackground("Background finished"),
      initialHold = fake.queueHeld({ chunks: ["Background working"] });
    await b.fill(search, "No matching scale title");
    await beginBackground(finished, "Background first work");
    await waitFor(
      () => app.index.get(finished.id)?.status,
      (status) => status === "busy",
    );
    await waitFor(() => providerSaw("Background first work"), Boolean);
    const project = `[data-project-sessions~="${finished.id}"]`;
    await visibleLight(b, `${project} .otk-status-light[data-state=working]`);
    await c.rpc("session.abort", { sessionID: finished.id });
    await waitFor(
      () => app.index.get(finished.id)?.status,
      (status) => status === "idle",
    );
    initialHold.release();
    fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf scale_background",
          description: "Background permission",
        },
      },
    });
    const finishHold = fake.queueHeld({ chunks: ["Background completed"] });
    await beginBackground(finished, "Background needs input");
    await waitFor(
      () => app.index.get(finished.id)?.attention.permissions,
      (count) => (count ?? 0) > 0,
    );
    await visibleLight(b, `${project} .otk-status-light[data-state=blocked]`);
    const requests = await c.rpc<PermissionRequest[]>("permission.list", {
      sessionID: finished.id,
    });
    await c.rpc("permission.reply", {
      sessionID: finished.id,
      requestID: requests[0].id,
      reply: "once",
    });
    finishHold.release();
    await waitFor(
      () => app.index.get(finished.id)?.status,
      (status) => status === "idle",
    );
    await visibleLight(b, `${project} .otk-status-light[data-state=finished]`);
    const working = await createBackground("Background working");
    fake.queueHeld({ chunks: ["Still working"] });
    await beginBackground(working, "Keep background work active");
    await waitFor(
      () => app.index.get(working.id)?.status,
      (status) => status === "busy",
    );
    await waitFor(() => providerSaw("Keep background work active"), Boolean);
    const blocked = await createBackground("Background blocked");
    fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf scale_blocked",
          description: "Retained background permission",
        },
      },
    });
    await beginBackground(blocked, "Keep background input visible");
    await waitFor(
      () => app.index.get(blocked.id)?.attention.permissions,
      (count) => (count ?? 0) > 0,
    );
    await c.rpc("layout.location", {
      sidecarId: "local",
      directory: background,
      sessionID: working.id,
    });
    await b.click('[aria-label="Collapse projects"]');
    await b.click(".otk-panel-collapse");
    await waitForCollapsedPanels(b);
    browserRuns.push(await b.evaluate("globalThis.scale"));
    await b.reload();
    await waitForCollapsedPanels(b);
    await visibleLight(b, `${project} .otk-status-light[data-state=blocked]`);
    await capture("collapsed-background-after-reload");
    await b.click(`${project} .otk-project-open`);
    await b.poll(`location.hash.endsWith('/${working.id}')`);
    for (
      const [id, state] of [
        [finished.id, "finished"],
        [working.id, "working"],
        [blocked.id, "blocked"],
      ]
    ) {
      await visibleLight(
        b,
        `[data-tab="${id}"] .otk-status-light[data-state=${state}]`,
      );
    }
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-project-sessions').length",
      ),
      0,
    );
    await capture("mandatory-phantoms-after-reload");
    observations.background = {
      finished: finished.id,
      working: working.id,
      blocked: blocked.id,
    };
    // ResourceScope owns the held provider and native lifetimes through teardown.
    await c.rpc("layout.patch", {
      leftCollapsed: false,
      rightCollapsed: false,
      rightView: "sessions",
    });
    await b.goto(`${url}/#/local/${selected.id}`);
    await b.fill(search, "");
    // Complete warm snapshot includes all exact summaries and turn metadata.
    const readinessStarted = performance.now(), target = SCALE.sessions + 4;
    const readinessProgress: { elapsed: number; ready: number }[] = [];
    observations.warmReadiness = { target, progress: readinessProgress };
    while (ready.size < target) {
      const previous = ready.size;
      // Elapsed backfill is a measurement. Only lack of further completed work
      // uses the fixture's ordinary liveness bound; never fail a progressing scan.
      await waitFor(() => ready.size, (count) => count > previous);
      readinessProgress.push({
        elapsed: performance.now() - readinessStarted,
        ready: ready.size,
      });
    }
    assertEquals(ready.size, target);
    console.info(
      "Scale warm readiness wait (ms)",
      performance.now() - readinessStarted,
    );
    browserRuns.push(await b.evaluate("globalThis.scale"));
    await b.reload();
    await b.poll("scale.paints.length>0", 120000);
    const warm = await b.evaluate<typeof cold>("scale.paints[0]");
    console.info("Session scale warm paint (ms)", warm.elapsed);
    assertEquals(
      warm.snapshot.ready,
      true,
      "Warm snapshot must contain all ready summaries",
    );
    console.info("Scale warm paint", theme, warm);
    observations.warm = warm;
    await b.poll(
      `document.querySelector('[data-session="${selected.id}"] .otk-session-cost')?.textContent===${
        JSON.stringify(usageCost(selected.expected.cost!))
      }`,
    );
    assert(
      Math.abs(
        (await b.evaluate<number>(
          "Number(document.querySelector('.otk-context-meter').dataset.cost)",
        )) - selected.expected.cost!,
      ) < 1e-8,
    );
    for (const i of [2, 3]) {
      assertEquals(
        await b.evaluate(
          `document.querySelector('[data-session="${
            f.manifest.sessions[i].id
          }"] .otk-session-cost')?.textContent`,
        ),
        usageCost(f.manifest.sessions[i].expected.cost!),
      );
    }
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-session=opcv1-ses_scale000001] .otk-session-digest-state')?.textContent",
      ),
      "Usage unavailable",
    );
    await capture("warm-ready");
    // The current connection may warm active/attention scopes. List rows admit
    // no model/point/detail requests, and nonselected bodies stop at two pages.
    const sent = sentFrames(b);
    const allCalls = sent.map((event) => event.frame).filter((frame) =>
      frame.t === "rpc"
    );
    const current = sent.slice(
      sent.findLastIndex(({ frame }) => frame.t === "hello"),
    );
    const calls = current.map((e) => e.frame).filter((f) => f.t === "rpc");
    assertEquals(allCalls.filter((f) => f.method === "usage.get").length, 0);
    const attention = new Set([finished.id, blocked.id]);
    const attentionReads = allCalls.filter((frame) =>
      frame.method === "permission.list" &&
      attention.has(String((frame.params as { sessionID?: string })?.sessionID))
    );
    assertEquals(
      attentionReads.length,
      2,
      "Each deliberately blocked background session has one notification detail read",
    );
    observations.attentionReads = attentionReads;
    const warmScopes = new Set([
      ...taskMembers,
      ...f.manifest.sessions.filter((row) => row.directory === background).map(
        (row) => row.id,
      ),
      finished.id,
      working.id,
      blocked.id,
    ]);
    assertScopedWarming(calls, selected.id, warmScopes, attention);
    await wheelViewport(b, viewport, 100000);
    await b.poll(
      `!!document.querySelector('[data-session="${
        f.manifest.sessions[250].id
      }"]')`,
    );
    assert(
      (await b.evaluate<number>(
        "document.querySelectorAll('.otk-session-row').length",
      )) < 45,
    );
    await capture("last-row");
    assertEquals(
      await b.evaluate(
        `document.querySelector('[data-session="${
          f.manifest.sessions[250].id
        }"] .otk-session-cost').textContent`,
      ),
      usageCost(f.manifest.sessions[250].expected.cost!),
    );
    observations.window = await windowBound(b);
    const last = f.manifest.sessions[250];
    await b.evaluate(
      `globalThis.pinnedScale=document.querySelector('[data-session="${last.id}"]');pinnedScale.focus()`,
    );
    await b.evaluate(framesAhead);
    await wheelViewport(b, viewport, -100000);
    await b.poll(
      "document.activeElement===pinnedScale && pinnedScale.isConnected",
    );
    await windowBound(b, 1);
    await b.evaluate(`document.querySelector('${search}').focus()`);
    await b.poll(`!document.querySelector('[data-session="${last.id}"]')`);
    await wheelViewport(b, viewport, 100000);
    await b.poll(`!!document.querySelector('[data-session="${last.id}"]')`);
    const anchor = await b.evaluate<{ key: string; offset: number }>(
      anchorProbe,
    );
    await c.rpc("tasks.sessions", {
      id: groupedTask.id,
      sessions: [f.manifest.sessions[4].id, selected.id],
    });
    await b.evaluate(framesAhead);
    const reordered = await b.evaluate<typeof anchor>(anchorProbe);
    assertEquals(reordered.key, anchor.key);
    assert(Math.abs(reordered.offset - anchor.offset) < 1);
    const renameMenu = await openContext(b, `[data-session="${last.id}"]`);
    await b.click(`${renameMenu} [data-context-command^="session.rename"]`);
    await b.poll("!!document.querySelector('[aria-label=\"Rename session\"]')");
    await b.fill('[aria-label="Rename session"]', last.title + " renamed");
    await b.key("Enter");
    await b.poll(
      `!document.querySelector('.otk-title-editor') && document.querySelector('[data-session="${last.id}"] .otk-row-title')?.textContent===${
        JSON.stringify(last.title + " renamed")
      }`,
    );
    assertEquals(
      (await c.rpc<{ title: string }>("session.get", { sessionID: last.id }))
        .title,
      last.title + " renamed",
    );
    const edited = await b.evaluate<typeof anchor>(anchorProbe);
    assertEquals(edited.key, anchor.key);
    assert(Math.abs(edited.offset - anchor.offset) < 1);
    await b.fill(search, "Scale session 0005");
    await b.poll("document.querySelectorAll('.otk-session-row').length===2");
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-session=opcv1-ses_scale000004]')!==null",
      ),
      true,
    );
    await capture("search-ancestry");
    for (const width of [280, 480]) {
      await c.rpc("layout.patch", { rightWidth: width });
      await b.poll(
        `Math.abs(document.querySelector('.otk-right-panel').getBoundingClientRect().width-${width})<1`,
      );
      await b.evaluate(framesAhead);
      assert(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-session-row')].every(row=>{const a=row.querySelector('.otk-status-light').getBoundingClientRect(),b=row.querySelector('.otk-row-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)<=1})",
        ),
      );
      assert(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-session-row .otk-row-title')].every(e=>getComputedStyle(e).whiteSpace==='nowrap')",
        ),
      );
      const gaps = await b.evaluate<number[]>(
        "(()=>{const c=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),i=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [i.left-c.left,c.right-i.right,i.top-c.top,c.bottom-i.bottom]})()",
      );
      assert(Math.max(...gaps) - Math.min(...gaps) <= 1, JSON.stringify(gaps));
    }
    await b.fill(search, "");
    await wheelViewport(b, viewport, -100000);
    await b.poll(`!!document.querySelector('[data-session="${selected.id}"]')`);
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-session-row')].slice(0,3).map(row=>row.dataset.session)",
      ),
      [f.manifest.sessions[4].id, f.manifest.sessions[5].id, selected.id],
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('[data-session="${selected.id}"]').getAttribute('aria-current')`,
      ),
      "page",
    );
    assertEquals(b.errors, []);
    await resources().capture();
    await c.close();
    await b.close();
    await app.stop();
  });
}
