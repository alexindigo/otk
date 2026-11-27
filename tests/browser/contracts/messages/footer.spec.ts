// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

const clock = ".otk-message-details > .otk-chrome-meta > time[title]";

test.describe("shared message footer", () => {
  test.use({ profile: "contract-messages-window" });
  test(
    "messages.footer-always-visible",
    { tag: ["@messages", "@contracts"] },
    async ({ isolatedState: state, page }, info) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await state.product("prefs.set", { key: "timestamps", value: false });
      await openSession(state, page, "tstv1-other-finished");
      const footers = page.locator(".otk-message .otk-message-footer");
      await expect(footers).toHaveCount(2);
      for (const message of await page.locator(".otk-message").all()) {
        await expect.soft(message.locator("time[title]:visible")).toHaveCount(
          1,
        );
      }
      const actionGaps = await footers.evaluateAll((elements) =>
        elements.map((footer) => {
          const meta = footer.querySelector(".otk-message-details")!
            .getBoundingClientRect();
          const bounds = footer.getBoundingClientRect();
          const action = footer.querySelector("[data-message-command]")!
            .getBoundingClientRect();
          const lastAction = Array.from(
            footer.querySelectorAll("[data-message-command]"),
          ).at(-1)!.getBoundingClientRect();
          const style = getComputedStyle(footer);
          return {
            gap: action.left - meta.right,
            expected: parseFloat(style.columnGap),
            padding: parseFloat(style.paddingInlineEnd),
            replyRight: footer.closest('[data-role="assistant"]')
              ? bounds.right - lastAction.right
              : 0,
          };
        })
      );
      for (const geometry of actionGaps) {
        expect.soft(geometry.padding).toBe(0);
        expect.soft(Math.abs(geometry.gap - geometry.expected)).toBeLessThan(1);
        expect.soft(Math.abs(geometry.replyRight)).toBeLessThan(1);
      }
      const check = async () => {
        for (const footer of await footers.all()) {
          await expect(footer.locator(clock)).toBeVisible();
          await expect(footer.locator("[data-message-command]").first())
            .toBeVisible();
          expect(
            await footer.evaluate((element, clock) =>
              Array.from(
                element.querySelectorAll(`${clock}, [data-message-command]`),
              )
                .every((node) => {
                  for (let e: Element | null = node; e; e = e.parentElement) {
                    const style = getComputedStyle(e);
                    if (
                      style.visibility !== "visible" ||
                      Number(style.opacity) === 0 || style.display === "none"
                    ) return false;
                  }
                  return true;
                }), clock),
          ).toBe(true);
          expect(
            await footer.evaluate((element, selector) => {
              const clock = element.querySelector(selector)!.parentElement!
                .getBoundingClientRect();
              const action = element.querySelector("[data-message-command]")!
                .getBoundingClientRect();
              return Math.abs(
                clock.y + clock.height / 2 - action.y - action.height / 2,
              );
            }, clock),
          ).toBeLessThan(.5);
        }
      };
      await page.mouse.move(5, 5);
      await check();
      const before = await footers.evaluateAll((elements) =>
        elements.map((e) => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        })
      );
      await footers.first().hover();
      await check();
      await footers.last().locator("button").first().focus();
      await check();
      await page.locator("textarea[name=prompt]").focus();
      await page.mouse.move(5, 5);
      await check();
      expect(
        await footers.evaluateAll((elements) =>
          elements.map((e) => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          })
        ),
      ).toEqual(before);
      for (
        const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
          "otk-light-stone",
          "stone",
        ]]
      ) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await check();
        await page.screenshot({
          path: info.outputPath(`msg-width-footers-${name}.png`),
          fullPage: true,
        });
      }
      await state.product("prefs.set", { key: "timestamps", value: true });
      await check();
    },
  );
});
