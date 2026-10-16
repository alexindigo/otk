// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import type { Cdp } from "../support/cdp.ts";
import {
  closeNotificationSettings,
  focusNotifications,
  hideNotifications,
  instrumentNotifications,
  notificationSettings,
} from "../support/notification-browser.ts";
const toast = (id: string, sidecar = "local") =>
  `.otk-toast[data-note='${sidecar}/${id}']`;
const badge = "document.querySelector('link[rel=icon]')?.title";
async function assertBadgeAsset(browser: Cdp, count: number) {
  const asset = await browser.evaluate<{ dot: boolean; count: number }>(
    `(() => {
    const icon=document.querySelector('link[rel=icon]');
    const svg=new DOMParser().parseFromString(decodeURIComponent(icon.href.split(',')[1]),'image/svg+xml');
    return {dot:!!svg.querySelector('circle'),count:svg.querySelector('circle') ? Number(svg.querySelector('text:last-child').textContent) : 0};
  })()`,
  );
  assertEquals(asset, { dot: count > 0, count });
}
async function seed(
  f: Awaited<ReturnType<typeof browserFixture>>,
  title: string,
) {
  return await f.oc.request<{ id: string }>("/session", {
    method: "POST",
    body: { title },
  });
}
async function finish(
  f: Awaited<ReturnType<typeof browserFixture>>,
  ws: WsClient,
  id: string,
  reply = "Background completed",
) {
  f.fake.queue({ chunks: [reply], delay: 100 });
  await ws.rpc("session.prompt", {
    sessionID: id,
    mode: "normal",
    parts: [{ kind: "text", text: "Run notification completion" }],
  });
}
Deno.test("D6 focused background completion opens only after accepted dirty navigation; selected completion stays silent", async () => {
  const f = await browserFixture();
  let ws: WsClient | undefined;
  try {
    const a = await seed(f, "Open A"), b = await seed(f, "Background B");
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await focusNotifications(browser);
    await openSession(browser, a.id);
    ws = new WsClient(server.url);
    await ws.connect();
    await browser.fill("textarea[name=prompt]", "Keep unsent draft");
    await finish(f, ws, b.id);
    await browser.poll(
      `document.querySelector("${
        toast(b.id)
      }")?.textContent.includes('Session done')`,
    );
    await browser.poll(`${badge}==='1 sessions need attention'`);
    await browser.dialog(
      () => browser.click(`${toast(b.id)} .otk-toast-actions button`),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Keep unsent draft",
    );
    assertEquals(await browser.evaluate(badge), "1 sessions need attention");
    assert(
      await browser.evaluate(
        `location.hash.endsWith('/${a.id}') && !!document.querySelector("${
          toast(b.id)
        }")`,
      ),
    );
    await browser.dialog(
      () => browser.click(`${toast(b.id)} .otk-toast-actions button`),
      true,
    );
    await browser.poll(
      `location.hash.endsWith('/${b.id}') && document.querySelector('[data-role=assistant] .otk-text')?.textContent==='Background completed' && !document.querySelector("${
        toast(b.id)
      }") && ${badge}==='OTK'`,
    );
    await finish(f, ws, b.id, "Selected completed");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=assistant] .otk-text')].some(el=>el.textContent==='Selected completed') && !document.querySelector('.otk-streaming')",
    );
    assertEquals(
      await browser.evaluate("document.querySelectorAll('.otk-toast').length"),
      0,
    );
    assertEquals(await browser.evaluate(badge), "OTK");
  } finally {
    await ws?.close();
    await f.stop();
  }
});
Deno.test("D7 real hidden/granted Notification tag replacement, session favicon count, guarded default action and focus retraction", async () => {
  const f = await browserFixture();
  let ws: WsClient | undefined, restore: (() => Promise<void>) | undefined;
  try {
    const a = await seed(f, "Open A"),
      b = await seed(f, "Background B"),
      c = await seed(f, "Background C");
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await instrumentNotifications(browser);
    await browser.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["notifications"],
    });
    await browser.goto(server.url);
    await focusNotifications(browser);
    await openSession(browser, a.id);
    await notificationSettings(browser);
    await browser.click("input[name='notify.os']");
    await browser.poll(
      "document.querySelector('input[name=\"notify.os\"]').checked && notificationEvidence.permissionRequests===1",
    );
    await closeNotificationSettings(browser);
    await browser.fill("textarea[name=prompt]", "Keep OS draft");
    ws = new WsClient(server.url);
    await ws.connect();
    restore = await hideNotifications(browser);
    await finish(f, ws, b.id);
    await browser.poll("notificationEvidence.notes.length===1");
    await assertBadgeAsset(browser, 1);
    await finish(f, ws, b.id, "Replacement completed");
    await browser.poll(
      "notificationEvidence.notes.length===2 && notificationEvidence.notes[0].closed",
    );
    assertEquals(
      await browser.evaluate(
        "notificationEvidence.notes.map(n=>n.options.tag)",
      ),
      [`local/${b.id}`, `local/${b.id}`],
    );
    await assertBadgeAsset(browser, 1);
    await finish(f, ws, c.id);
    await browser.poll(
      `notificationEvidence.notes.length===3 && ${badge}==='2 sessions need attention'`,
    );
    assertEquals(
      await browser.evaluate("document.querySelectorAll('.otk-toast').length"),
      0,
    );
    await assertBadgeAsset(browser, 2);
    // Model the browser bringing the page forward before dispatching a queued
    // native Notification click. Focus retracts presentation, not its live note.
    await restore();
    restore = undefined;
    await browser.poll("notificationEvidence.notes.every(n=>n.closed)");
    await browser.dialog(
      () =>
        browser.evaluate(
          "notificationEvidence.notes[1].instance.dispatchEvent(new Event('click',{cancelable:true}))",
        ),
      false,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Keep OS draft",
    );
    assertEquals(await browser.evaluate(badge), "2 sessions need attention");
    await browser.dialog(
      () =>
        browser.evaluate(
          "notificationEvidence.notes[1].instance.dispatchEvent(new Event('click',{cancelable:true}))",
        ),
      true,
    );
    await browser.poll(
      `location.hash.endsWith('/${b.id}') && [...document.querySelectorAll('[data-role=assistant] .otk-text')].some(el=>el.textContent==='Replacement completed')`,
    );
    await browser.poll(
      `notificationEvidence.notes.every(n=>n.closed) && ${badge}==='1 sessions need attention'`,
    );
    await assertBadgeAsset(browser, 1);
    await openSession(browser, c.id);
    await browser.poll(`${badge}==='OTK'`);
    await assertBadgeAsset(browser, 0);
    console.info(
      "D7 evidence: native Notification constructor/tag/close/default-handler observed; desktop presentation and physical click not asserted",
    );
  } finally {
    await restore?.();
    await ws?.close();
    await f.stop();
  }
});
Deno.test("D8 OS opt-in calls actual denied browser permission, persists host choice, exposes blocked status and hidden toast fallback", async () => {
  const f = await browserFixture();
  let ws: WsClient | undefined, restore: (() => Promise<void>) | undefined;
  try {
    const a = await seed(f, "Open A"), b = await seed(f, "Denied background");
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await instrumentNotifications(browser);
    await browser.send("Browser.setPermission", {
      origin: server.url,
      permission: { name: "notifications" },
      setting: "denied",
    });
    await browser.goto(server.url);
    await focusNotifications(browser);
    await openSession(browser, a.id);
    await notificationSettings(browser);
    await browser.click("input[name='notify.os']");
    await browser.poll(
      "notificationEvidence.permissionRequests===1 && document.querySelector('input[name=\"notify.os\"]').checked && document.querySelector('.otk-notification-browser').textContent.includes('Blocked by browser')",
    );
    await browser.reload();
    await focusNotifications(browser);
    await notificationSettings(browser);
    await browser.poll(
      "document.querySelector('input[name=\"notify.os\"]').checked && document.querySelector('.otk-notification-browser').textContent.includes('Blocked by browser')",
    );
    await closeNotificationSettings(browser);
    ws = new WsClient(server.url);
    await ws.connect();
    restore = await hideNotifications(browser);
    await finish(f, ws, b.id);
    await browser.poll(
      `document.querySelector("${
        toast(b.id)
      }")?.textContent.includes('Session done')`,
    );
    assertEquals(
      await browser.evaluate("notificationEvidence.notes.length"),
      0,
    );
    await restore();
    restore = undefined;
    await browser.click(`${toast(b.id)} .otk-toast-message`);
    await browser.poll(
      `!document.querySelector("${
        toast(b.id)
      }") && ${badge}==='1 sessions need attention'`,
    );
    await openSession(browser, b.id);
    await browser.poll(`${badge}==='OTK'`);
  } finally {
    await restore?.();
    await ws?.close();
    await f.stop();
  }
});
Deno.test("granted but unsupported Notification constructor exposes unavailability and uses in-page fallback", async () => {
  const f = await browserFixture();
  let ws: WsClient | undefined, restore: (() => Promise<void>) | undefined;
  try {
    const a = await seed(f, "Open A"),
      b = await seed(f, "Unavailable background");
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await instrumentNotifications(browser, true);
    await browser.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["notifications"],
    });
    await browser.goto(server.url);
    await focusNotifications(browser);
    await openSession(browser, a.id);
    await notificationSettings(browser);
    await browser.click("input[name='notify.os']");
    await browser.poll(
      "document.querySelector('input[name=\"notify.os\"]').checked",
    );
    await closeNotificationSettings(browser);
    ws = new WsClient(server.url);
    await ws.connect();
    restore = await hideNotifications(browser);
    await finish(f, ws, b.id);
    await browser.poll(`!!document.querySelector("${toast(b.id)}")`);
    await restore();
    restore = undefined;
    await notificationSettings(browser);
    await browser.poll(
      "document.querySelector('.otk-notification-browser').textContent.includes('unavailable')",
    );
  } finally {
    await restore?.();
    await ws?.close();
    await f.stop();
  }
});
Deno.test("D9 background child Allow once targets originating remote family and produces actual stock tool/file outcome", async () => {
  const local = await browserFixture(), remote = await browserFixture();
  let ws: WsClient | undefined;
  try {
    const a = await seed(local, "Local selected"),
      b = await seed(remote, "Remote parent");
    const server = await local.sidecar(),
      other = await remote.sidecar({
        server: { port: await freePort(), origins: [server.url] },
      });
    const browser = await local.browser(server.url);
    await focusNotifications(browser);
    await openSession(browser, a.id);
    await notificationSettings(browser);
    await browser.fill("input[name=url]", other.url);
    await browser.fill("input[name=label]", "Remote notification host");
    await browser.click(
      ".otk-settings-content > .otk-form button[type=submit]",
    );
    await browser.poll(
      "[...document.querySelectorAll('.otk-toast[data-kind=info]')].some(el=>el.textContent.includes('Server added'))",
    );
    await browser.poll(
      "[...document.querySelectorAll('[data-settings-sidecar]')].some(el=>el.textContent.includes('Remote notification host') && el.textContent.includes('connected'))",
    );
    const sidecar = await browser.evaluate<string>(
      "[...document.querySelectorAll('[data-settings-sidecar]')].find(el=>el.textContent.includes('Remote notification host')).dataset.settingsSidecar",
    );
    await closeNotificationSettings(browser);
    await browser.fill("textarea[name=prompt]", "Retain local draft");
    ws = new WsClient(other.url);
    await ws.connect();
    remote.fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "Notification child",
            prompt: "Run permission tool",
          },
        },
      },
      {
        tool: {
          name: "bash",
          input: {
            command:
              "printf notification-tool-result > notification-result.txt; cat notification-result.txt",
            description: "Notification tool result",
          },
        },
      },
      { chunks: ["Child accepted"] },
      { chunks: ["Parent accepted"] },
    );
    await ws.rpc("session.prompt", {
      sessionID: b.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Delegate notification permission" }],
    });
    const children = await waitFor(
      () => remote.oc.request<{ id: string }[]>(`/session/${b.id}/children`),
      (rows) => rows.length > 0,
      60000,
    );
    await browser.poll(
      `document.querySelector("${
        toast(b.id, sidecar)
      }")?.textContent.includes('Allow once')`,
      60000,
    );
    assertEquals(
      await browser.evaluate(
        `document.querySelectorAll("${toast(b.id, sidecar)}").length`,
      ),
      1,
    );
    await browser.click(
      `${toast(b.id, sidecar)} .otk-toast-actions button:last-child`,
    );
    const messages = await waitFor(
      () =>
        remote.oc.request<
          {
            parts: {
              type: string;
              state?: { status: string; output?: string };
            }[];
          }[]
        >(`/session/${children[0].id}/message`),
      (rows) =>
        rows.some((m) =>
          m.parts.some((p) =>
            p.type === "tool" && p.state?.status === "completed" &&
            p.state.output?.includes("notification-tool-result")
          )
        ),
      60000,
    );
    assert(messages.length > 0);
    assertEquals(
      await Deno.readTextFile(
        join(remote.oc.directory, "notification-result.txt"),
      ),
      "notification-tool-result",
    );
    assert(
      sentFrames(browser).some(({ frame }) =>
        frame.method === "permission.reply" &&
        (frame.params as { sessionID: string }).sessionID === children[0].id
      ),
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Retain local draft",
    );
    assert(await browser.evaluate(`location.hash.endsWith('/${a.id}')`));
    console.info(
      "D9 observed stock child tool completed output and actual file content",
      children[0].id,
    );
  } finally {
    await ws?.close();
    await local.stop();
    await remote.stop();
  }
});
Deno.test("Web Audio gesture unlock schedules distinct running done/input tone graphs; notification preference reloads", async () => {
  const f = await browserFixture();
  let ws: WsClient | undefined;
  try {
    const a = await seed(f, "Open A"), b = await seed(f, "Sound background");
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await instrumentNotifications(browser);
    await browser.goto(server.url);
    await focusNotifications(browser);
    assertEquals(
      await browser.evaluate("notificationEvidence.contexts.length"),
      0,
    );
    await openSession(browser, a.id);
    await notificationSettings(browser);
    await browser.click("input[name='notify.sound']");
    await browser.poll(
      "document.querySelector('input[name=\"notify.sound\"]').checked",
    );
    await closeNotificationSettings(browser);
    ws = new WsClient(server.url);
    await ws.connect();
    await browser.poll(
      "notificationEvidence.contexts.length===1 && notificationEvidence.contexts[0].context.state==='running'",
    );
    await finish(f, ws, b.id);
    await browser.poll("notificationEvidence.audio.length===2");
    await browser.poll("notificationEvidence.audio.every(n=>n.peaks.length>0)");
    assertEquals(
      await browser.evaluate("notificationEvidence.audio.map(n=>n.frequency)"),
      [660, 880],
    );
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "echo audio-input", description: "Audio input" },
      },
    });
    await ws.rpc("session.prompt", {
      sessionID: b.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Input tone probe" }],
    });
    await browser.poll("notificationEvidence.audio.length===5");
    await browser.poll("notificationEvidence.audio.every(n=>n.peaks.length>0)");
    assertEquals(
      await browser.evaluate(
        "notificationEvidence.audio.slice(2).map(n=>n.frequency)",
      ),
      [880, 660, 880],
    );
    assert(
      await browser.evaluate(
        "notificationEvidence.contexts.every(n=>n.gesture) && notificationEvidence.audio.every(n=>n.state==='running')",
      ),
    );
    assert(
      await browser.evaluate(
        "notificationEvidence.audio.every(n=>n.peaks.some(hz=>Math.abs(hz-n.frequency)<30))",
      ),
    );
    await browser.reload();
    await focusNotifications(browser);
    await notificationSettings(browser);
    await browser.poll(
      "document.querySelector('input[name=\"notify.sound\"]').checked",
    );
    console.info(
      "Sound proof observes genuine running Web Audio graphs, scheduled frequencies and analyser output peaks, not physical speaker audibility",
    );
  } finally {
    await ws?.close();
    await f.stop();
  }
});
