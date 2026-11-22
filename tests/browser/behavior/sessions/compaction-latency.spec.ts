// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { expectCompactionSummary, prompt } from "../../pages/transcript.ts";

test("sessions.compaction-keeps-transcript-redraw-latency", {
  tag: ["@sessions", "@load"],
}, async ({ state, page }, info) => {
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Compaction redraw latency",
  });
  await openSession(state, page, s.id);
  const prompts = [
    "Trace the session action owners",
    "Keep the transcript as the only content store",
    "Verify the final consumer outcome",
  ];
  for (const text of prompts) {
    const reply = Array(18).fill(`Response to ${text}.`).join(" ");
    await state.queue([reply]);
    await prompt(page, text);
    await expect(page.locator(".otk-messages")).toContainText(reply);
    await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
  }
  const sample = () =>
    page.evaluate(() =>
      new Promise<number[]>((resolve) => {
        const start = performance.now(), gaps: number[] = [];
        let previous = start;
        const frame = (now: number) => {
          gaps.push(now - previous);
          previous = now;
          if (now - start >= 1500) resolve(gaps);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      })
    );
  const before = await sample();
  const probe = await page.evaluateHandle(() => {
    const probe = {
      start: Infinity,
      frames: [] as { at: number; gap: number }[],
      stop: false,
    };
    const click = (event: MouseEvent) => {
      if (
        (event.target as Element).closest('[data-command="session.compact"]')
      ) {
        probe.start = performance.now();
        previous = probe.start;
      }
    };
    document.addEventListener("click", click, { capture: true });
    let previous = performance.now();
    const frame = (at: number) => {
      probe.frames.push({ at, gap: at - previous });
      previous = at;
      if (!probe.stop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return {
      finish() {
        probe.stop = true;
        document.removeEventListener("click", click, { capture: true });
        return probe.frames.filter((f) => f.at >= probe.start).map((f) =>
          f.gap
        );
      },
    };
  });
  let after: number[] = [];
  try {
    await state.queue(["## Objective\n\nCompaction latency summary."]);
    await page.keyboard.press("Control+k");
    await page.locator('[data-command="session.compact"]').click();
    await expectCompactionSummary(state, page, "Compaction latency summary.");
  } finally {
    after = await probe.evaluate((probe) => probe.finish());
    await probe.dispose();
    await info.attach("redraw-latency", {
      body: JSON.stringify({ before, after }),
      contentType: "application/json",
    });
  }
  const settled = await sample();
  const percentile = (gaps: number[]) =>
    [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * .95)];
  expect(after.length).toBeGreaterThan(0);
  expect(percentile(after), "Post-compaction redraw p95 vs pre-compaction")
    .toBeLessThan(Math.max(100, percentile(before) * 2));
  expect(percentile(settled), "Settled redraw p95 vs pre-compaction")
    .toBeLessThan(Math.max(100, percentile(before) * 2));
});
