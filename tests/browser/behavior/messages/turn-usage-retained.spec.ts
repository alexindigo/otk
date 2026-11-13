// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test.use({ profile: "messages-tools" });
test("messages.completed-turn-usage-retained-while-next-turn-runs", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(120000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Retained turn usage",
    // More than the native 200-header ceiling, independent of adaptive quotas.
    messages: Array.from({ length: 240 }, (_, i) => ({
      parts: [{ type: "text", text: `Historical prompt ${i}` }],
    })),
  });
  const capture = await wire(page);
  await openSession(state, page, session.id);
  await state.queue(["The first reply is finished."]);
  await prompt(page, "Give me a short reply");
  await expect(page.locator(".otk-messages")).toContainText(
    "The first reply is finished.",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const first = page.locator("[data-role=assistant]").first().locator(
    ".otk-turn-usage, footer .otk-control-label",
  ).first();
  await expect(first).toContainText("1 model call");
  const baseline = capture.received.length;
  // Record every footer text the completed turn shows from now on.
  await page.evaluate((id) => {
    const seen: string[] = [];
    const cues: { meter: string; row: string }[] = [];
    (globalThis as unknown as { __firstFooter: string[] }).__firstFooter = seen;
    (globalThis as unknown as { __usageCues: typeof cues }).__usageCues = cues;
    const read = () => {
      const footer = document.querySelector("[data-role=assistant] footer");
      const text = footer?.textContent ?? "<missing>";
      if (seen.at(-1) !== text) seen.push(text);
      const cue = {
        meter: document.querySelector(".otk-context-meter")?.textContent ?? "",
        row: document.querySelector(
          `[data-session="${id}"] .otk-session-digest-state`,
        )?.textContent ?? "",
      };
      if (JSON.stringify(cues.at(-1)) !== JSON.stringify(cue)) cues.push(cue);
    };
    read();
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, session.id);
  const held = await state.controller.call<{ gate: string }>("queueScript", {
    lease: state.lease.lease,
    chunks: ["The second reply is still arriving.", "\n\nMore follows."],
    delay: 100,
    gate: "held",
  });
  await prompt(page, "Ok, now it works");
  await expect(page.locator("[data-role=assistant]")).toHaveCount(2);
  await expect(
    page.locator("[data-role=assistant] .otk-message-content").last(),
  ).toContainText("More follows.");
  // The next turn is running; give the digest scheduler time to react.
  await page.waitForTimeout(6000);
  await state.release(held.gate);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await page.waitForTimeout(4000);
  const seen = await page.evaluate(() =>
    (globalThis as unknown as { __firstFooter: string[] }).__firstFooter
  );
  console.log("first-footer-transitions " + JSON.stringify(seen));
  console.log(
    "usage-cues " + JSON.stringify(
      await page.evaluate(() =>
        (globalThis as unknown as { __usageCues: unknown[] }).__usageCues
      ),
    ),
  );
  console.log(
    "digest-frames " +
      JSON.stringify(
        capture.received.slice(baseline).flatMap((frame) => {
          if (frame.t !== "index.patch") return [];
          return (frame.ops as {
            op: string;
            revision?: number;
            summary?: { state: string; messageCount?: number };
            turns?: { upsert: Record<string, unknown> };
          }[])
            .filter((op) => op.op === "digest")
            .map((op) => ({
              revision: op.revision,
              state: op.summary?.state,
              messageCount: op.summary?.messageCount,
              turns: op.turns?.upsert,
            }));
        }),
      ),
  );
  expect(
    seen.filter((text) => !text.includes("1 model call")),
    JSON.stringify(seen),
  ).toEqual([]);
});
