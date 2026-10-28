// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { Cdp } from "../support/cdp.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { tempDir } from "../support/resources.ts";
import { menuReady } from "../support/menu.ts";

async function capture(b: Cdp, name: string) {
  const destination = Deno.env.get("OTK_DIGEST_SCREENSHOTS");
  if (destination) await b.screenshot(join(destination, name + ".png"));
}
async function context(
  b: Cdp,
  id: string,
  selector = `[data-session="${id}"]`,
) {
  const point = await b.evaluate<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector(${
      JSON.stringify(selector)
    }).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await b.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      clickCount: 1,
    });
  }
  await menuReady(b, ':popover-open [role="menu"][aria-label="Context menu"]');
}

test("shipped summaries update rows and footers without detail; deletion retains task and opens metadata-only details", async () => {
  const f = await browserFixture({ bash: "allow" });
  let client: WsClient | undefined;
  try {
    const server = await f.sidecar();
    const root = await f.oc.session<{ id: string; nativeID: string }>(
      "/session",
      { method: "POST", body: { title: "Digest supervision" } },
    );
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("tasks.create", {
      directory: f.oc.directory,
      name: "Retained work",
      sessions: [root.id],
    });
    const b = await f.browser(server.url);
    await openSession(b, root.id);
    f.fake.queue({ chunks: ["A digested reply."] });
    await b.fill('textarea[name="prompt"]', "Keep this reply visible");
    await b.key("Enter");
    await waitForReply(b, root.id, "A digested reply.");
    await b.poll(
      `!!document.querySelector('[data-session="${root.id}"] .otk-session-cost') && document.querySelector('.otk-turn-usage-trigger')?.textContent.includes('model call')`,
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "usage.get").length,
      0,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const gaps = await b.evaluate<number[]>(
        `[...document.querySelectorAll('.otk-session-row')].flatMap(row=>{const boxes=['.otk-list-row-leading','.otk-list-row-label','.otk-list-row-trailing'].map(s=>row.querySelector(s).getBoundingClientRect());const ys=boxes.map(r=>r.y+r.height/2);return ys.map(y=>Math.abs(y-ys[0]));})`,
      );
      assertEquals(gaps.every((gap) => gap <= 1), true, JSON.stringify(gaps));
      const iconGaps = await b.evaluate<number[]>(
        "(()=>{const control=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),icon=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [icon.left-control.left,control.right-icon.right,icon.top-control.top,control.bottom-icon.bottom]})()",
      );
      assertEquals(
        Math.max(...iconGaps) - Math.min(...iconGaps) <= 1,
        true,
        JSON.stringify(iconGaps),
      );
      await capture(b, `${theme}-ready-summaries`);
    }
    const point = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.otk-turn-usage-trigger').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await b.poll("!!document.querySelector('.otk-usage-breakdown tbody tr')");
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "usage.get").length,
      1,
    );
    await b.key("Escape");
    await b.fill('textarea[name="prompt"]', "Unsent draft survives deletion");
    await client.rpc("permission.auto", { sessionID: root.id, enabled: true });
    await f.oc.request(`/session/${root.nativeID}`, { method: "DELETE" });
    await b.poll(
      "!!document.querySelector('.otk-deleted-session') && !document.querySelector('.otk-prompt')",
    );
    assertEquals(await b.evaluate("location.hash"), `#/local/${root.id}`);
    const tasks = await client.rpc<{ sessions: string[] }[]>("tasks.list", {});
    assertEquals(tasks.some((task) => task.sessions.includes(root.id)), true);
    const policy = client.frames.findLast((frame) => frame.t === "approvals");
    assertEquals(
      policy?.t === "approvals" && policy.approvals.enabled.includes(root.id),
      false,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const contrast = await b.evaluate<number[]>(
        `(()=>{const css=getComputedStyle(document.documentElement),title=document.querySelector('[data-session="${root.id}"] .otk-row-title'),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d'),rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=css.getPropertyValue('--otk-bg-side');ctx.fillRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(n=>n/255)},lum=color=>rgb(color).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0),fg=lum(getComputedStyle(title).color);return ['--otk-bg','--otk-bg-side','--otk-selected'].map(key=>{const bg=lum(css.getPropertyValue(key));return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)})})()`,
      );
      assertEquals(
        contrast.every((ratio) => ratio >= 4.5),
        true,
        JSON.stringify(contrast),
      );
      await context(b, root.id);
      const items = await b.evaluate<string[]>(
        "[...document.querySelectorAll(':popover-open [data-context-command]')].map(el=>el.dataset.contextCommand)",
      );
      assertEquals(
        items.filter((id) =>
          [
            "session.rename",
            "session.fork",
            "session.delete",
            "permission.auto",
            "task.add",
            "session.pin",
            "session.preview",
          ].includes(id)
        ),
        [],
      );
      assertEquals(items.includes("session.task.remove"), true);
      assertEquals(items.includes("session.title.copy"), true);
      await capture(b, `${theme}-deleted-details-menu`);
      await b.key("Escape");
    }
    const reloadFrames = sentFrames(b).length;
    await b.reload();
    await b.poll("!!document.querySelector('.otk-deleted-session')");
    assertEquals(
      await b.evaluate("!!document.querySelector('[data-role=assistant]')"),
      false,
    );
    assertEquals(
      sentFrames(b).slice(reloadFrames).filter(({ frame }) => {
        const params = frame.params as { sessionID?: string } | undefined;
        return params?.sessionID === root.id &&
          [
            "session.get",
            "session.messages",
            "models.list",
            "usage.get",
            "permission.list",
            "question.list",
          ].includes(String(frame.method));
      }),
      [],
    );
    const removalFrames = sentFrames(b).length;
    await b.click(".otk-deleted-session .otk-control-row button:nth-child(2)");
    await b.poll(
      `!!document.querySelector('.otk-tab[data-preview="true"] [data-tab="${root.id}"]')`,
    );
    assertEquals(await b.evaluate("location.hash"), `#/local/${root.id}`);
    assertEquals(
      sentFrames(b).slice(removalFrames).filter(({ frame }) =>
        ["session.get", "session.messages", "usage.get"].includes(
          String(frame.method),
        )
      ),
      [],
    );
    await b.click(".otk-deleted-session .otk-control-row button:last-child");
    await b.poll("!document.querySelector('.otk-deleted-session')");
    assertEquals(b.errors, []);
  } finally {
    await client?.close();
    await f.stop();
  }
});

test("accepted tombstones release content and resurrection reacquires once while retaining the draft", async () => {
  // Chromium's profile singleton uses a Unix socket under its disk TMPDIR.
  const root = await tempDir("ds-");
  const f = await coreBackendFixture(root);
  const b = await Cdp.launch(root);
  try {
    await b.goto(`${f.url}/#/local/${f.session.id}`);
    await b.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('Core transcript')",
    );
    await openSession(b, f.session.id);
    await b.fill('textarea[name="prompt"]', "A retained unsent draft");
    const client = new WsClient(f.url);
    await client.connect();
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, `${theme}-digesting`);
    }
    const delta = {
      id: f.session.id,
      revision: 1,
      summary: { state: "digesting" as const, revision: 1 },
      turns: { upsert: {}, remove: [] },
      deleted: { at: 1, how: "provider" as const },
    };
    f.app.index.applyDigest(delta);
    await b.poll(
      "!!document.querySelector('.otk-deleted-session') && !document.querySelector('.otk-prompt')",
    );
    const count = sentFrames(b).filter(({ frame }) =>
      frame.method === "session.messages"
    ).length;
    f.app.index.applyDigest({
      ...delta,
      revision: 2,
      summary: { state: "ready", revision: 2 },
      deleted: null,
    });
    await b.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('Core transcript') && document.querySelector('textarea[name=prompt]')?.value==='A retained unsent draft'",
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "session.messages")
        .length,
      count + 1,
    );
    assertEquals(await b.evaluate("location.hash"), `#/local/${f.session.id}`);
    assertEquals(b.errors, []);
    await client.close();
  } finally {
    await b.close();
    await f.app.stop();
  }
});

test("external deletion retains dirty permission input and closing still uses the normal release guard", async () => {
  const f = await browserFixture({ bash: "ask" });
  try {
    const root = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Unsent permission input" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, root.id);
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "pwd", description: "Read the project directory" },
      },
    });
    await b.fill('textarea[name="prompt"]', "Ask before running pwd");
    await b.key("Enter");
    await b.poll("!!document.querySelector('.otk-rejection-reason')");
    await b.fill(".otk-rejection-reason", "Keep my unsent permission feedback");
    await f.oc.request(`/session/${root.id}`, { method: "DELETE" });
    await b.poll(
      "document.querySelector('.otk-deleted-session')?.textContent.includes('Keep my unsent permission feedback') && !document.querySelector('.otk-permission-dock')",
    );
    await b.dialog(
      () => b.click(".otk-deleted-session .otk-control-row button:last-child"),
      false,
    );
    assertEquals(await b.evaluate("location.hash"), `#/local/${root.id}`);
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-deleted-session').textContent.includes('Keep my unsent permission feedback')",
      ),
      true,
    );
    await b.dialog(
      () => b.click(".otk-deleted-session .otk-control-row button:last-child"),
      true,
    );
    await b.poll("!document.querySelector('.otk-deleted-session')");
  } finally {
    await f.stop();
  }
});

test("unknown summaries and rejected detail never render a fictitious zero ledger", async () => {
  const root = await tempDir("du-");
  const f = await coreBackendFixture(root, {
    usage: {
      getUsage: () =>
        Promise.reject(
          new Error("Detailed usage is unavailable for unreported headers"),
        ),
    },
  });
  f.app.backend.core.listMessages = () =>
    Promise.resolve([{
      id: "reply",
      sessionID: f.session.id,
      role: "assistant",
      replyTo: "turn",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1, completed: 2 },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    }]);
  const summary = {
    calls: 1,
    cost: null,
    tokens: {
      input: null,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    contextPeak: null,
  };
  f.app.index.applyDigest({
    id: f.session.id,
    revision: 1,
    summary: { state: "ready", revision: 1, total: summary },
    turns: { upsert: { turn: summary }, remove: [] },
    deleted: null,
  });
  const b = await Cdp.launch(root);
  try {
    await b.goto(`${f.url}/#/local/${f.session.id}`);
    await b.poll(
      "document.querySelector('.otk-turn-usage-trigger')?.textContent.includes('Tokens unavailable') && document.querySelector('.otk-turn-usage-trigger').textContent.includes('Cost unavailable')",
    );
    const point = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.otk-turn-usage-trigger').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await b.poll(
      "document.querySelector('.otk-turn-usage :popover-open')?.textContent.includes('Detailed usage is unavailable for unreported headers')",
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('.otk-usage-breakdown') || document.querySelector('.otk-message-footer').textContent.includes('$0.00')",
      ),
      false,
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});
test("summary-only backends show facts without a dead usage control or context action", async () => {
  const root = await tempDir("sf-");
  const f = await coreBackendFixture(root);
  f.app.backend.core.listMessages = () =>
    Promise.resolve([{
      id: "reply",
      sessionID: f.session.id,
      role: "assistant",
      replyTo: "turn",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1, completed: 2 },
      tokens: {
        input: 2,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: .25,
      interrupted: false,
      parts: [],
    }]);
  const summary = {
    calls: 1,
    cost: .25,
    tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    contextPeak: 2,
  };
  f.app.index.applyDigest({
    id: f.session.id,
    revision: 1,
    summary: { state: "ready", revision: 1, total: summary },
    turns: { upsert: { turn: summary }, remove: [] },
    deleted: null,
  });
  const b = await Cdp.launch(root);
  try {
    await b.goto(`${f.url}/#/local/${f.session.id}`);
    await b.poll(
      "document.querySelector('.otk-message-footer')?.textContent.includes('1 model call')",
    );
    assertEquals(
      await b.evaluate("!!document.querySelector('.otk-turn-usage-trigger')"),
      false,
    );
    await context(b, f.session.id, '[data-role="assistant"]');
    assertEquals(
      await b.evaluate(
        "!!document.querySelector(':popover-open [data-context-command=\"reply.usage\"]')",
      ),
      false,
    );
    assertEquals(
      sentFrames(b).some(({ frame }) => frame.method === "usage.get"),
      false,
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});
