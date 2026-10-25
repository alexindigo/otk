// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
test("revert controls are absent while working and in read-only helpers", async () => {
  const f = await browserFixture();
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Root" },
    });
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Helper", parentID: root.id },
    });
    await f.oc.request(`/session/${child.id}/message`, {
      method: "POST",
      body: { noReply: true, parts: [{ type: "text", text: "Helper prompt" }] },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, root.id);
    const held = f.fake.queueHeld({ chunks: ["Work in progress."] });
    await b.fill('textarea[name="prompt"]', "Keep working");
    await b.key("Enter");
    await b.poll(
      `document.querySelector('[data-session="${root.id}"]').dataset.status==='busy'`,
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('[data-message-command=\"prompt.revert\"]')",
      ),
      false,
    );
    held.release();
    await waitForReply(b, root.id, "Work in progress.");
    await b.poll(
      "!!document.querySelector('[data-message-command=\"prompt.revert\"]')",
    );
    await openSession(b, child.id);
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('[data-message-command=\"prompt.revert\"]')",
      ),
      false,
    );
  } finally {
    await f.stop();
  }
});
