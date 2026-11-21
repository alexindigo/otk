// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { scrollTranscript, wheelTranscript } from "../../pages/transcript.ts";

test.describe("complete-content inline footprint", () => {
  test.use({ profile: "contract-messages-window" });
  test("messages.inline-footprint-first-materialization", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1000, height: 540 });
    await openSession(state, page, "tstv1-inline-tail");
    const bubble = page.locator(
      '[data-message="geometry-prompt"] .otk-user-bubble',
    );
    await expect(bubble.locator("img")).toBeVisible();
    await expect(bubble.locator(".otk-text p")).toHaveCount(0);
    const initial = await bubble.boundingBox();
    await scrollTranscript(page, false);
    await expect(bubble.locator(".otk-text p")).toBeVisible();
    const complete = await bubble.boundingBox();
    expect(Math.abs(initial!.width - complete!.width)).toBeLessThan(.5);
    expect(Math.abs(initial!.x - complete!.x)).toBeLessThan(.5);
  });
  for (const session of ["atmosphera", "globnotes", "luch"]) {
    test(`messages.inline-footprint-${session}`, {
      tag: ["@messages", "@contracts"],
    }, async ({ isolatedState: state, page }, info) => {
      await state.product("layout.patch", {
        leftCollapsed: true,
        rightCollapsed: true,
      });
      await page.setViewportSize({ width: 1000, height: 760 });
      await openSession(state, page, `tstv1-${session}`);
      for (const [width, scale] of [[1000, 100], [840, 100], [1000, 125]]) {
        await page.setViewportSize({ width, height: 760 });
        await state.product("prefs.set", {
          key: "textSize",
          value: String(scale),
        });
        await scrollTranscript(page, false);
        const bubble = page.locator(
          '[data-message="geometry-prompt"] .otk-user-bubble',
        );
        await expect(bubble).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          )
        );
        const start = await bubble.boundingBox();
        expect(start).toBeTruthy();
        if (session === "luch") expect(start!.width).toBeLessThan(300);
        await page.evaluate(() => {
          const bubble = document.querySelector(
            '[data-message="geometry-prompt"] .otk-user-bubble',
          )!;
          const image = bubble.querySelector("img");
          const rect = (e: Element) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, width: r.width };
          };
          const initial = {
            bubble: rect(bubble),
            image: image ? rect(image) : undefined,
          };
          const samples: unknown[] = [], failures: unknown[] = [];
          const probe = {
            running: true,
            samples,
            failures,
            initial,
            retired: 0,
          };
          Object.assign(globalThis, { inlineProbe: probe });
          const tick = () => {
            if (!probe.running) return;
            const pane = document.querySelector(".otk-messages")!
              .getBoundingClientRect();
            const b = bubble.getBoundingClientRect();
            if (
              bubble.isConnected && b.bottom > pane.top && b.top < pane.bottom
            ) {
              if (!bubble.querySelector(".otk-text p")) probe.retired++;
              const currentImage = bubble.querySelector("img");
              const sample = {
                bubble: rect(bubble),
                image: currentImage ? rect(currentImage) : undefined,
              };
              samples.push(sample);
              if (
                Math.abs(sample.bubble.x - initial.bubble.x) > .5 ||
                Math.abs(sample.bubble.width - initial.bubble.width) > .5 ||
                sample.image && initial.image &&
                  (Math.abs(sample.image.x - initial.image.x) > .5 ||
                    Math.abs(sample.image.width - initial.image.width) > .5)
              ) failures.push(sample);
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const distance = Math.max(40, start!.height - 80);
        for (const direction of [1, -1, 1, -1]) {
          for (let step = 0; step < 8; step++) {
            await wheelTranscript(page, direction * distance / 8);
          }
        }
        const result = await page.evaluate(() => {
          const probe = (globalThis as unknown as {
            inlineProbe: {
              running: boolean;
              samples: unknown[];
              failures: unknown[];
              initial: unknown;
              retired: number;
            };
          }).inlineProbe;
          probe.running = false;
          return probe;
        });
        await info.attach(`inline-${width}-${scale}.json`, {
          body: JSON.stringify(result),
          contentType: "application/json",
        });
        expect(result.samples.length).toBeGreaterThan(8);
        expect(result.failures, JSON.stringify(result.initial)).toEqual([]);
        if (session === "atmosphera") expect(result.retired).toBeGreaterThan(0);
        if (session === "atmosphera" && width === 1000 && scale === 100) {
          await wheelTranscript(page, distance);
          await expect(bubble.locator(".otk-text p")).toHaveCount(0);
          await expect(bubble.locator("img")).toBeVisible();
          for (
            const [theme, name] of [["otk-dark", "dark"], [
              "otk-light",
              "linen",
            ], ["otk-light-stone", "stone"]]
          ) {
            await state.product("prefs.set", { key: "theme", value: theme });
            await expect(page.locator("html")).toHaveAttribute(
              "data-otk-theme",
              theme,
            );
            await page.screenshot({
              path: info.outputPath(`msg-width-clipped-${name}.png`),
              fullPage: true,
            });
          }
        }
      }
    });
  }
});
