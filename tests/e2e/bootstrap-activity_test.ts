// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  waitForCollapsedPanels,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("native bootstrap without SQLite keeps already-working and blocked phantom tabs visible after reload with collapsed panels", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  const held = f.fake.queueHeld({ chunks: ["Working before OTK connects"] });
  try {
    const busy = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Already working" },
    });
    await f.oc.request(`/session/${busy.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Keep working" }] },
    });
    await waitFor(
      () => f.oc.request<Record<string, { type: string }>>("/session/status"),
      (statuses) => statuses[busy.id]?.type === "busy",
    );
    // Wait until the held script is consumed before queuing the second session.
    await waitFor(
      () => f.fake.requests,
      (requests) =>
        requests.some((request) =>
          request.stream === true &&
          (request.messages as { role: string; content: unknown }[])
            .some((message) =>
              message.role === "user" && message.content === "Keep working"
            )
        ),
    );
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "pwd", description: "Pending before OTK connects" },
      },
    });
    const blocked = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Already blocked" },
    });
    await f.oc.request(`/session/${blocked.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Ask before running pwd" }] },
    });
    await waitFor(
      () => f.oc.request<{ sessionID: string }[]>("/permission"),
      (requests) => requests.some((r) => r.sessionID === blocked.id),
    );
    const server = await f.sidecar({
      harness: { url: f.oc.url, db: join(f.oc.root, "unreadable.db") },
    });
    client = new WsClient(server.url);
    await client.connect();
    const browser = await f.browser(server.url);
    const row = `[data-project=${JSON.stringify(f.oc.directory)}]`;
    await browser.poll(`!!document.querySelector(${JSON.stringify(row)})`);
    await browser.click(`${row} .otk-project-open`);
    const visible = async () => {
      for (
        const [id, state] of [[busy.id, "working"], [blocked.id, "blocked"]]
      ) {
        const selector = `.otk-tab[data-kind=phantom] [data-tab=${
          JSON.stringify(id)
        }] .otk-status-light[data-state=${state}]`;
        await browser.poll(
          `!!document.querySelector(${JSON.stringify(selector)})`,
        );
        assert(
          await browser.evaluate(
            `(()=>{const e=document.querySelector(${
              JSON.stringify(selector)
            });const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.checkVisibility()})()`,
          ),
          selector,
        );
      }
      assertEquals(
        await browser.evaluate(
          `document.querySelector(${JSON.stringify(row)}).dataset.rollup`,
        ),
        "blocked",
      );
    };
    await visible();
    await client.rpc("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await waitForCollapsedPanels(browser);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.reload();
      await waitForCollapsedPanels(browser);
      await visible();
      const path = join(f.oc.root, `quality-A1-${theme}.png`);
      await browser.screenshot(path);
      console.info("A1 activity capture:", path);
    }
  } finally {
    held.release();
    await client?.close();
    await f.stop();
  }
});
