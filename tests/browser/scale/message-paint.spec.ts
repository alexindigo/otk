// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import {
  measureMessagePaint,
  type MessagePaintEvidence,
} from "../../support/message-measurements.ts";

test.use({ profile: "contract-scale-paint" });
for (let repetition = 0; repetition < 5; repetition++) {
  test(
    `scale.newest10-cold-preloaded-paint-${repetition}`,
    { tag: ["@scale"] },
    async ({ isolatedState: state, page }, info) => {
      test.setTimeout(180_000);
      const initial = await state.observe<
        {
          counts: unknown;
          expectedCounts: { sessions: number };
          ready: string[];
          manifest: { sessions: { id: string; directory: string }[] };
        }
      >();
      expect(initial.counts).toEqual(initial.expectedCounts);
      const selected = initial.manifest.sessions[0],
        landing = initial.manifest.sessions[251],
        openMain = `[data-project=${
          JSON.stringify(selected.directory)
        }] .otk-project-open`,
        openLanding = `[data-project=${
          JSON.stringify(landing.directory)
        }] .otk-project-open`;
      await page.setViewportSize({ width: 1280, height: 900 });
      await measureMessagePaint(
        { send: (_method, { source }) => page.addInitScript(source) },
        selected.id,
        openMain,
      );
      await page.goto(`${state.url}/#/local/${landing.id}`);
      await expect(page.locator("textarea[name=prompt]")).toBeVisible();
      await expect.poll(() =>
        page.evaluate("messageMeasurements.snapshots.length > 0")
      ).toBe(true);
      expect(
        await page.evaluate(
          "messageMeasurements.snapshots.every(s=>s.count===0 || s.count===1)",
        ),
      ).toBe(true);
      expect(await page.evaluate("messageMeasurements.requests.length")).toBe(
        0,
      );
      const before = performance.now(),
        browserNow = await page.evaluate(() => performance.now()),
        sync = { before, browser: browserNow, after: performance.now() };
      await page.locator(openMain).click();
      const observations: unknown[] = [];
      try {
        await expect.poll(() =>
          page.evaluate("messageMeasurements.paints.length")
        ).toBe(1);
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "stop",
        });
        const cold = await page.evaluate<MessagePaintEvidence>(
          "messageMeasurements",
        );
        observations.push({ repetition, mode: "cold", ...cold });
        const first = cold.pages.find((p) => p.ok);
        expect(first?.ok && first.ids).toBeTruthy();
        expect(first!.ids).toEqual(
          Array.from(
            { length: 10 },
            (_, i) => `msg_scale${String(1515 + i).padStart(9, "0")}`,
          ),
        );
        expect(cold.paints).toHaveLength(1);
        // Rule 1 makes the initial scoped snapshot empty. Measure incomplete
        // population coverage at its owner instead of treating [] as all-ready.
        expect(initial.ready.length).toBeLessThan(
          initial.expectedCounts.sessions,
        );
        await expect.poll(() =>
          page.locator(".otk-message-flow").getAttribute("data-message-count")
            .then(Number)
        ).toBeGreaterThanOrEqual(20);
        await page.locator(openLanding).click();
        await expect(page).toHaveURL(new RegExp(`/${landing.id}$`));
        await expect(page.locator("textarea[name=prompt]")).toBeVisible();
        const reads = await page.evaluate<number>(
          "messageMeasurements.requests.filter(r=>!r.before).length",
        );
        await page.locator(openMain).click();
        await expect.poll(() =>
          page.evaluate("messageMeasurements.paints.length")
        ).toBe(1);
        const preloaded = await page.evaluate<MessagePaintEvidence>(
          "messageMeasurements",
        );
        observations.push({ repetition, mode: "preloaded", ...preloaded });
        expect(preloaded.paints).toHaveLength(1);
        expect(preloaded.requests.filter((r) => !r.before)).toHaveLength(reads);
        console.info(
          "Scale paint measurements",
          JSON.stringify({ repetition, observations }),
        );
      } finally {
        await info.attach("population-control-measurements", {
          body: JSON.stringify({
            initial,
            sync,
            observations,
            consumer: await page.evaluate("messageMeasurements"),
            server: await state.observe(),
          }),
          contentType: "application/json",
        });
      }
    },
  );
}
