// SPDX-License-Identifier: LGPL-3.0-only
// Delivery witness (M1 WP1.5): every message that reaches opencode reaches the
// open OTK transcript, in native order, without a reload. Assertions read the
// visible transcript only.
import type { Locator, Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { compactionBoundary, prompt } from "../../pages/transcript.ts";

const TAGS = { tag: ["@messages", "@transport"] };

/** A page-lifetime marker: a reload or navigation would erase it. */
async function markPage(page: Page) {
  await page.evaluate(() => {
    (globalThis as { witnessPage?: boolean }).witnessPage = true;
  });
}
async function expectNoReload(page: Page) {
  expect(
    await page.evaluate(() =>
      (globalThis as { witnessPage?: boolean }).witnessPage === true
    ),
  ).toBe(true);
}
const visible = (page: Page, text: string) =>
  page.locator(".otk-messages").getByText(text, { exact: true });
/** Each item is visible and follows the previous one in the transcript. */
async function expectInOrder(
  items: Locator[],
  timeout?: number,
) {
  for (const item of items) {
    await expect(item.first()).toBeVisible(timeout ? { timeout } : {});
  }
  for (let i = 1; i < items.length; i++) {
    const [before, after] = [
      await items[i - 1].first().elementHandle(),
      await items[i].first().elementHandle(),
    ];
    expect(
      await before!.evaluate(
        (a, b) => !!(a.compareDocumentPosition(b!) & 4),
        after,
      ),
    ).toBe(true);
  }
}
async function session(state: TestState, title: string, seeded = false) {
  return await state.native<{ id: string }>("/session", "POST", {
    title,
    ...(seeded
      ? {
        messages: [{
          parts: [{ type: "text", text: "Context before native compaction" }],
        }],
      }
      : {}),
  });
}

test(
  "messages.delivery-witness-other-client-prompt-and-reply",
  TAGS,
  async ({ isolatedState: state, page }) => {
    const target = await session(state, "Witness other client");
    await openSession(state, page, target.id);
    await markPage(page);
    await state.queue(["Reply to the other client."]);
    await state.native(`/session/${target.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Prompt from another client" }],
    });
    await expectInOrder([
      visible(page, "Prompt from another client"),
      visible(page, "Reply to the other client."),
    ]);
    await expectNoReload(page);
  },
);

test(
  "messages.delivery-witness-native-compaction-then-prompt-and-reply",
  TAGS,
  async ({ isolatedState: state, page }) => {
    test.setTimeout(120_000);
    const target = await session(state, "Witness native compaction", true);
    await openSession(state, page, target.id);
    await markPage(page);
    // Another client compacts natively (2.49): OTK did not request it.
    await state.queue(["## Objective\n\nA native witness summary."]);
    await state.native(`/session/${target.id}/summarize`, "POST", {
      providerID: "fake",
      modelID: "scripted",
    });
    const compaction = compactionBoundary(state);
    await expect(page.locator(compaction.title)).toHaveText(
      compaction.completed,
    );
    await state.queue(["Reply after the native compaction."]);
    await state.native(`/session/${target.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Pickup context after compaction" }],
    });
    await expectInOrder([
      page.locator(compaction.title),
      visible(page, "Pickup context after compaction"),
      visible(page, "Reply after the native compaction."),
    ]);
    await expectNoReload(page);
  },
);

test(
  "messages.delivery-witness-otk-restart-mid-turn-keeps-reply-and-send",
  TAGS,
  async ({ isolatedState: state, page }) => {
    test.setTimeout(120_000);
    const target = await session(state, "Witness restart mid-turn");
    await openSession(state, page, target.id);
    await markPage(page);
    const gate = await state.queue([
      "Reply started before the restart ",
      "and finished after it.",
    ], "held");
    await prompt(page, "Prompt before OTK restarts");
    await expect(page.locator(`[data-session="${target.id}"]`))
      .toHaveAttribute("data-status", "busy");
    // Busy can already reflect the pending Send. Restart only once the
    // native turn has actually reached the held provider response.
    await expect.poll(async () =>
      (await state.observe<{ active: number }>()).active
    ).toBe(1);
    await state.controller.call("restart", {
      lease: state.lease.lease,
      target: "sidecar",
    });
    await state.release(gate.gate);
    await expectInOrder([
      visible(page, "Prompt before OTK restarts"),
      visible(page, "Reply started before the restart and finished after it."),
    ]);
    await expect(page.locator(`[data-session="${target.id}"]`))
      .toHaveAttribute("data-status", "idle");
    // 2.51: Send after the restart uses the current request window.
    await state.queue(["Reply on the current request window."]);
    await prompt(page, "Send after the restart");
    await expectInOrder([
      visible(page, "Reply started before the restart and finished after it."),
      visible(page, "Send after the restart"),
      visible(page, "Reply on the current request window."),
    ]);
    await expectNoReload(page);
  },
);

test.describe("stalled native stream", () => {
  test.use({ profile: "transport-stall" });
  test(
    "messages.delivery-witness-stalled-stream-repairs-within-bound",
    TAGS,
    async ({ isolatedState: state, page }, info) => {
      test.setTimeout(180_000);
      const target = await session(state, "Witness stalled stream");
      await openSession(state, page, target.id);
      await markPage(page);
      // The open event stream stops delivering bytes without closing (2.30).
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "freeze",
      });
      await state.queue(["Reply while the stream stalled."]);
      const started = Date.now();
      await state.native(`/session/${target.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "Prompt while the stream stalled" }],
      });
      // Repair bound: the silence watchdog (V1: this profile's configured 2 s;
      // V2: its 45 s protocol minimum, V2_SILENCE_MS), then one resync.
      const silence = state.controller.info!.version.startsWith("2.")
        ? 45_000
        : 2_000;
      const bound = silence + 30_000;
      await expectInOrder([
        visible(page, "Prompt while the stream stalled"),
        visible(page, "Reply while the stream stalled."),
      ], bound);
      const repaired = Date.now() - started;
      await info.attach("stalled-stream-repair", {
        contentType: "application/json",
        body: JSON.stringify({
          repairedMs: repaired,
          transport: await state.observe(),
        }),
      });
      expect(repaired).toBeLessThan(bound);
      await expectNoReload(page);
    },
  );
});
