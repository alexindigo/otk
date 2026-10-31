// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { PermissionRequest } from "@otk/protocol";
import { coreBackendFixture } from "../support/core-backend.ts";
import { fixture } from "../support/config.ts";
import { test } from "../support/resources.ts";
import { Cdp } from "../support/cdp.ts";
import { sentFrames } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

test("hidden Activity releases demand across one hundred invalidations and reconnect; reacquire sees current keyed titles", async () => {
  const root = await fixture(), id = "tstv1-core";
  const pending: PermissionRequest[] = Array.from({ length: 100 }, (_, n) => ({
    id: `ask-${n}`,
    sessionID: id,
    kind: "bash",
    title: "bash",
    patterns: [`printf item-${n}`],
    alwaysPatterns: [],
    time: 1,
    detail: { kind: "bash", command: `printf item-${n}` },
  }));
  let publish: (requestID?: string) => void = () => {};
  const f = await coreBackendFixture(root, {
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
    permissions: {
      listPermissions: () => Promise.resolve([...pending]),
      replyPermission: ({ requestID }) => {
        const at = pending.findIndex((request) => request.id === requestID);
        if (at < 0) {
          return Promise.reject(new Error("Request is no longer pending"));
        }
        pending.splice(at, 1);
        publish(requestID);
        return Promise.resolve();
      },
    },
  });
  publish = (requestID) => {
    const entry = f.app.index.get(id)!;
    f.app.index.upsertMetadata({
      ...entry,
      status: pending.length ? "busy" : "idle",
      attention: { ...entry.attention, permissions: pending.length },
    });
    if (requestID) {
      f.app.connections.content(id, {
        op: "permission.remove",
        sessionID: id,
        requestID,
      });
    }
  };
  publish();
  const browser = await Cdp.launch(root), client = new WsClient(f.url);
  const reads = () =>
    sentFrames(browser).filter(({ frame }) =>
      frame.method === "permission.activity"
    ).length;
  try {
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "globalThis.activitySockets=[];globalThis.WebSocket=class extends WebSocket{constructor(...args){super(...args);activitySockets.push(this)}}",
    });
    await browser.goto(`${f.url}/#/local/${id}`);
    await browser.poll(
      "!!document.querySelector('.otk-prompt') && !!document.querySelector('[data-panel-view=activity]')",
    );
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await browser.click('[aria-label="Open right panel"]');
    await browser.click('[data-panel-view="activity"]');
    await browser.poll(
      "document.querySelector('.otk-permission-activity')?.textContent.includes('Permission replies will appear here.')",
    );
    assertEquals(reads(), 1);
    await browser.click('[aria-label="Collapse right panel"]');
    await browser.poll("!document.querySelector('.otk-permission-activity')");
    for (const request of pending.slice(0, 100)) {
      await client.rpc("permission.reply", {
        sessionID: id,
        requestID: request.id,
        reply: "once",
      });
    }
    assertEquals(
      pending.length,
      0,
      "the backend retires every answered request",
    );
    // A real transport replacement while the selected panel remains unmounted.
    await browser.evaluate(
      "activitySockets.filter(socket=>socket.readyState===WebSocket.OPEN).forEach(socket=>socket.close())",
    );
    await browser.poll(
      "activitySockets.length>=2 && activitySockets.at(-1).readyState===WebSocket.OPEN && document.querySelector('.otk-connection-light')?.dataset.connectionState==='connected'",
    );
    await browser.poll(
      "!!document.querySelector('.otk-prompt') && !document.querySelector('.otk-permission-dock')",
    );
    assertEquals(
      reads(),
      1,
      "hidden journal invalidations and reconnect issue zero Activity reads",
    );
    await browser.click('[aria-label="Open right panel"]');
    await browser.poll(
      "document.querySelectorAll('.otk-permission-activity [data-activity]').length===100 && !document.querySelector('.otk-permission-activity [role=status]:not([aria-hidden=true])')",
    );
    assertEquals(
      reads(),
      2,
      "reacquire makes exactly one latest first-page read",
    );
    const current = f.app.index.get(id)!;
    f.app.index.upsertMetadata({ ...current, title: "Current Activity title" });
    await browser.poll(
      "[...document.querySelectorAll('.otk-activity-entry > p:first-of-type')].length===100 && [...document.querySelectorAll('.otk-activity-entry > p:first-of-type')].every(row=>row.textContent==='Current Activity title')",
    );
    assertEquals(
      reads(),
      2,
      "one keyed title update never refetches journal rows",
    );
    const shots = Deno.env.get("OTK_C5_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"]]
      ) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme==='${theme}'`,
        );
        await browser.screenshot(join(shots, `activity-current-${name}.png`));
      }
    }
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});
