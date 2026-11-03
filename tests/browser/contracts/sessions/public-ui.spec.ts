// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-public-ui" });
test(
  "sessions.public-resizers-readiness-cancel-capture-loss-final-pointer-and-overlapping-saves",
  { tag: ["@sessions", "@contracts", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/?shared-controls`);
    await expect(page.locator(".otk-inbox-resizer")).toBeVisible();
    await page.locator("[data-ready]").click();
    for (const selector of [".otk-inbox-resizer", ".otk-panel-resizer"]) {
      await page.locator(selector).dispatchEvent("keydown", {
        key: "End",
        bubbles: true,
      });
    }
    await expect(page.locator("[data-calls]")).toHaveText("0");
    await page.locator("[data-ready]").click();
    for (
      const [selector, direction] of [[".otk-inbox-resizer", 1], [
        ".otk-panel-resizer",
        -1,
      ]] as const
    ) {
      const control = page.locator(selector);
      const original = Number(await control.getAttribute("aria-valuenow"));
      const calls = Number(await page.locator("[data-calls]").textContent());
      const begin = async () => {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        const point = {
          x: box!.x + box!.width / 2,
          y: box!.y + box!.height / 2,
        };
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await expect.poll(() => control.evaluate((e) => e.hasPointerCapture(1)))
          .toBe(true);
        return point;
      };
      for (const end of ["cancel", "lost", "unready"]) {
        const p = await begin();
        await page.mouse.move(p.x + 24 * direction, p.y);
        await expect(control).toHaveAttribute(
          "aria-valuenow",
          String(original + 24),
        );
        if (end === "cancel") {
          await control.dispatchEvent("pointercancel", {
            pointerId: 1,
            bubbles: true,
          });
        }
        if (end === "lost") {
          await control.evaluate((e) => e.releasePointerCapture(1));
        }
        if (end === "unready") {
          await page.locator("[data-ready]").evaluate((e: HTMLElement) =>
            e.click()
          );
        }
        await page.mouse.up();
        await expect(control).toHaveAttribute(
          "aria-valuenow",
          String(original),
        );
        await expect(page.locator("[data-calls]")).toHaveText(String(calls));
        if (end === "unready") await page.locator("[data-ready]").click();
      }
      const p = await begin();
      await page.mouse.move(p.x + 24 * direction, p.y);
      // Control the final event boundary independently of the last native move.
      await control.dispatchEvent("pointerup", {
        pointerId: 1,
        clientX: p.x + 40 * direction,
        clientY: p.y,
        button: 0,
        buttons: 0,
        bubbles: true,
      });
      await page.mouse.up();
      await expect(page.locator("[data-pending]")).toHaveText("1");
      await expect(control).toHaveAttribute(
        "aria-valuenow",
        String(original + 40),
      );
      await control.dispatchEvent("pointerup", {
        pointerId: 1,
        bubbles: true,
        clientX: 999,
      });
      await expect(page.locator("[data-calls]")).toHaveText(String(calls + 1));
      await page.locator("[data-reject]").click();
      await expect(control).toHaveAttribute("aria-valuenow", String(original));
      await control.dispatchEvent("keydown", {
        key: "ArrowRight",
        repeat: false,
        bubbles: true,
      });
      await control.dispatchEvent("keydown", {
        key: "ArrowRight",
        repeat: true,
        bubbles: true,
      });
      await expect(page.locator("[data-pending]")).toHaveText("2");
      await expect(control).toHaveAttribute(
        "aria-valuenow",
        String(original + 16 * direction),
      );
      await page.locator("[data-accept]").click();
      await expect(page.locator("[data-pending]")).toHaveText("1");
      await expect(control).toHaveAttribute(
        "aria-valuenow",
        String(original + 16 * direction),
      );
      await page.locator("[data-accept]").click();
      await expect(page.locator("[data-pending]")).toHaveText("0");
    }
    for (
      const [selector, width] of [[".otk-inbox-resizer", 360], [
        ".otk-panel-resizer",
        480,
      ]] as const
    ) {
      await page.locator(selector).dispatchEvent("keydown", {
        key: "End",
        bubbles: true,
      });
      await expect(page.locator("[data-pending]")).toHaveText("1");
      await page.locator("[data-accept]").click();
      await expect(page.locator(selector)).toHaveAttribute(
        "aria-valuenow",
        String(width),
      );
    }
  },
);
