// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { Page } from "@playwright/test";

const trigger = ".otk-turn-usage > button",
  panel = ".otk-turn-usage :popover-open",
  scroll = ".otk-usage-scroll";
const activity =
  "read: packages/client/session-usage.ts and every dependent consumer of the complete turn metadata";

async function point(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

for (const count of [3, 120] as const) {
  test.describe(`complete ${count}-call usage`, () => {
    test.use({
      profile: count === 3
        ? "contract-messages-usage3"
        : "contract-messages-usage120",
    });
    test(
      `messages.usage-layout-${count}`,
      { tag: ["@messages", "@contracts"] },
      async ({ isolatedState: state, page }) => {
        await page.goto(`${state.url}/#/local/tstv1-core`);
        await expect(page.locator(trigger)).toHaveText(
          new RegExp(`^${count} model calls`),
        );
        await expect(page.locator(".otk-composer-model-name")).toBeAttached();
        await expect(
          page.getByRole("region", { name: "Transcript", exact: true }),
        ).toHaveAttribute("aria-busy", "false");
        await expect(page.locator(".otk-text p")).toHaveText("Run complete.");
        if (count > 10) {
          await expect(page.locator(".otk-load-older")).toBeAttached();
        }
        await page.evaluate(() => document.fonts.ready);
        // Activate the fresh headless page through native input before exercising
        // focus/hover (the original 500-call control characterizes this boundary).
        await page.locator("textarea[name=prompt]").click();
        const closedRows = await page.locator(".otk-usage-breakdown tbody tr")
          .count();
        for (const [width, height] of [[1280, 720], [800, 600]]) {
          await page.setViewportSize({ width, height });
          await page.locator(trigger).evaluate((element) =>
            element.scrollIntoView({ block: "center" })
          );
          await page.locator(trigger).hover();
          await expect(page.locator(panel)).toBeVisible();
          await expect(page.locator(".otk-usage-breakdown tbody tr"))
            .toHaveCount(count);
          const bounds = await page.locator(panel).boundingBox();
          expect(
            bounds!.x >= 8 && bounds!.y >= 8 &&
              bounds!.x + bounds!.width <= width - 8 &&
              bounds!.y + bounds!.height <= height - 8,
            JSON.stringify(bounds),
          ).toBe(true);
          expect(closedRows).toBe(0);
          if (width === 1280) {
            expect(
              await page.locator(scroll).evaluate((element) =>
                element.scrollWidth === element.clientWidth
              ),
            ).toBe(true);
          }
          const edges = await page.evaluate(() =>
            [
              document.querySelector("tbody .otk-usage-context > span")!,
              document.querySelector("tfoot tr")!.children[1],
            ].map((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return range.getBoundingClientRect().right;
            })
          );
          expect(Math.abs(edges[0] - edges[1])).toBeLessThanOrEqual(.5);
          expect(
            await page.locator(".otk-usage-breakdown tbody tr").evaluateAll(
              (rows) =>
                rows.map((row) =>
                  Array.from(row.children).slice(2, 8).map((cell) =>
                    cell.textContent
                  )
                ),
            ),
          ).toEqual(Array.from({ length: count }, (_, index) =>
            [
              (index + 1) * 1000,
              (index + 1) * 800,
              80,
              20,
              (index + 1) * 150,
              (index + 1) * 50,
            ].map((value) => value.toLocaleString("en-US"))));
          expect(
            await page.locator(".otk-usage-breakdown tbody tr").evaluateAll(
              (rows) => rows.map((row) => row.children[8].textContent),
            ),
          ).toEqual(Array(count).fill("$0.01"));
          const n = count * (count + 1) / 2;
          const total = await page.locator(".otk-usage-breakdown tfoot tr")
            .evaluate((row) =>
              Array.from(row.children).map((cell) => cell.textContent)
            );
          expect(total[1]).toBe((n * 1000).toLocaleString("en-US"));
          const priced = await page.locator("tfoot .otk-usage-category-cost")
            .evaluateAll((elements) =>
              elements.map((element) => ({
                tokens: element.previousElementSibling!.textContent,
                exact: element.querySelector(".otk-usage-cost")!.getAttribute(
                  "aria-description",
                )!,
              }))
            );
          for (
            const [index, value] of [
              n * 800,
              count * 80,
              count * 20,
              n * 150,
              n * 50,
            ].entries()
          ) {
            expect(priced[index].tokens).toBe(value.toLocaleString("en-US"));
            expect(
              Math.abs(
                Number(priced[index].exact.split("$")[1].replaceAll(",", "")) -
                  value * [2, 4, 4, .5, 3][index] / 1e6,
              ),
            ).toBeLessThanOrEqual(1e-9);
          }
          expect(total[7]).toBe(`$${(count * .01).toFixed(2)}`);
          await expect(page.locator(".otk-usage-activity").first())
            .toHaveAttribute("aria-label", activity);
          expect(
            await page.locator(".otk-usage-activity span").first().evaluate(
              (element) =>
                element.scrollWidth > element.clientWidth &&
                getComputedStyle(element).textOverflow === "ellipsis",
            ),
          ).toBe(true);
          const bars = await page.locator(".otk-usage-context-bar > span")
            .evaluateAll((elements) =>
              elements.map((element) =>
                element.getBoundingClientRect().width /
                element.parentElement!.getBoundingClientRect().width
              )
            );
          expect(Math.abs(bars[0] - 1 / count)).toBeLessThanOrEqual(.01);
          expect(Math.abs(bars.at(-1)! - 1)).toBeLessThanOrEqual(.01);
          await expect(page.locator("[data-usage-summary=context]"))
            .toHaveAttribute(
              "aria-label",
              `Context peak: ${(count * 1000).toLocaleString("en-US")} tokens`,
            );
          const from = await point(page, trigger),
            to = await point(page, scroll);
          for (let step = 1; step <= 12; step++) {
            await page.mouse.move(
              from.x + (to.x - from.x) * step / 12,
              from.y + (to.y - from.y) * step / 12,
            );
          }
          await expect(page.locator(panel)).toBeVisible();
          const pinned = () =>
            page.evaluate(() =>
              [".otk-usage-summary", "thead th", "tfoot th"].map((selector) =>
                document.querySelector(selector)!.getBoundingClientRect().y
              )
            );
          const before = await pinned();
          await page.mouse.wheel(0, 20000);
          if (count > 3) {
            await expect.poll(() =>
              page.locator(scroll).evaluate((element) => element.scrollTop)
            ).toBeGreaterThan(0);
          }
          await expect(page.locator(panel)).toBeVisible();
          expect(await pinned()).toEqual(before);
          expect(
            await page.locator(scroll).evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return ["thead th", "tfoot th", "tbody tr:last-child"].every(
                (selector) => {
                  const box = element.querySelector(selector)!
                    .getBoundingClientRect();
                  return box.top >= rect.top && box.bottom <= rect.bottom;
                },
              );
            }),
          ).toBe(true);
          if (width === 800) {
            const columns = page.locator(
              "tbody tr:first-child > :nth-child(-n+2)",
            );
            const left = await columns.evaluateAll((elements) =>
              elements.map((element) => element.getBoundingClientRect().x)
            );
            await page.mouse.wheel(20000, 0);
            await expect.poll(() =>
              page.locator(scroll).evaluate((element) => element.scrollLeft)
            ).toBeGreaterThan(0);
            expect(
              await columns.evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect().x)
              ),
            ).toEqual(left);
            expect(
              await page.locator(scroll).evaluate((element) => {
                const rect = element.getBoundingClientRect(),
                  cost = element.querySelector("thead th:last-child")!
                    .getBoundingClientRect();
                return cost.right <= rect.right && cost.left >= rect.left;
              }),
            ).toBe(true);
          }
          await page.keyboard.press("Escape");
          await expect(page.locator(panel)).toHaveCount(0);
          await expect(page.locator(".otk-usage-breakdown tbody tr"))
            .toHaveCount(0);
          await page.mouse.move(1, 1);
          await page.locator(trigger).focus();
          await expect(page.locator(panel)).toBeVisible();
          // The preview owns its scroll/focus region even before detail arrives.
          await expect(page.locator(scroll)).toBeAttached();
          await page.keyboard.press("Tab");
          await expect(page.locator(scroll)).toBeFocused();
          await page.mouse.move(1, 1);
          await expect(page.locator(panel)).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.locator(panel)).toHaveCount(0);
          await expect(page.locator(trigger)).toBeFocused();
          await page.keyboard.press("Tab");
        }
      },
    );
  });
}

/** Continuously observe a specified real hover interval, never sleep for readiness. */
async function hoverInterval(page: Page, ms: number, open: boolean) {
  await page.evaluate(async ({ ms, open, panel }) => {
    const start = performance.now();
    while (performance.now() - start < ms) {
      if (!!document.querySelector(panel) !== open) {
        throw new Error(
          `Hover state changed inside ${ms}ms observation interval`,
        );
      }
      await new Promise(requestAnimationFrame);
    }
  }, { ms, open, panel });
}

test.describe("real hover intent", () => {
  test.use({ profile: "contract-messages-usage3" });
  test("messages.usage-hover-rest-focus-grace", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator(trigger)).toBeAttached();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("textarea[name=prompt]").click();
    await page.evaluate(({ trigger }) => {
      const button = document.querySelector(trigger)!,
        surface = document.getElementById(
          button.getAttribute("popovertarget")!,
        )!;
      const times: Record<string, number> = {};
      Object.assign(globalThis, { hoverTimes: times });
      button.addEventListener(
        "mousemove",
        () => times.move = performance.now(),
      );
      button.addEventListener("focus", () => times.focus = performance.now());
      surface.addEventListener(
        "mouseleave",
        () => times.leave = performance.now(),
      );
      surface.addEventListener(
        "beforetoggle",
        (event) => times[(event as ToggleEvent).newState] = performance.now(),
      );
    }, { trigger });
    const at = await point(page, trigger), away = () => page.mouse.move(1, 1);
    await page.locator(trigger).hover();
    await hoverInterval(page, 250, false);
    await away();
    await hoverInterval(page, 550, false);
    await page.locator(trigger).hover();
    await hoverInterval(page, 300, false);
    await page.mouse.move(at.x + 1, at.y);
    await hoverInterval(page, 300, false);
    await expect(page.locator(panel)).toBeVisible();
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(3);
    const opened = await page.evaluate<number>(
      "hoverTimes.open-hoverTimes.move",
    );
    expect(opened).toBeGreaterThanOrEqual(500);
    await expect(page.locator("textarea[name=prompt]")).toBeFocused();
    await page.locator(scroll).hover();
    await hoverInterval(page, 200, true);
    // Resolve the re-entry point before leaving. Locator actionability checks
    // themselves can consume the entire real 150ms grace interval.
    const reentry = await point(page, scroll);
    await away();
    await hoverInterval(page, 60, true);
    await page.mouse.move(reentry.x, reentry.y);
    await hoverInterval(page, 200, true);
    await away();
    await expect(page.locator(panel)).toHaveCount(0);
    const closed = await page.evaluate<number>(
      "hoverTimes.closed-hoverTimes.leave",
    );
    expect(closed).toBeGreaterThanOrEqual(150);
    expect(closed).toBeLessThan(500);
    await page.locator(trigger).focus();
    await expect(page.locator(panel)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    for (const reduced of [false, true]) {
      await page.emulateMedia({
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator(panel)).toBeVisible();
      await expect(page.locator(trigger)).toBeFocused();
      const focused = await page.evaluate<number>(
        "hoverTimes.open-hoverTimes.focus",
      );
      expect(focused).toBeGreaterThanOrEqual(0);
      expect(focused).toBeLessThan(500);
      await page.keyboard.press("Escape");
      await expect(page.locator(panel)).toHaveCount(0);
      await page.keyboard.press("Tab");
    }
    await page.locator(trigger).hover();
    await hoverInterval(page, 250, false);
    await expect(page.locator(panel)).toBeVisible();
    expect(await page.evaluate<number>("hoverTimes.open-hoverTimes.move"))
      .toBeGreaterThanOrEqual(500);
    await page.locator(trigger).focus();
    await page.keyboard.press("Escape");
    await hoverInterval(page, 550, false);
    await expect(page.locator(trigger)).toBeFocused();
    await info.attach("hover-timings", {
      body: JSON.stringify({ opened, closed }),
      contentType: "application/json",
    });
  });
});
