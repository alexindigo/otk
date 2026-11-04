// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";

test(
  "harness.pointer-stability",
  { tag: ["@harness", "@contracts"] },
  async ({ page }) => {
    for (const kind of ["summary", "button"] as const) {
      await page.setContent(
        kind === "summary"
          ? "<details><summary>Failure details</summary><p>Provenance</p></details>"
          : '<button aria-expanded="false">Error details</button>',
      );
      await page.evaluate(() => {
        const target = document.querySelector<HTMLElement>("summary,button")!;
        target.style.cssText =
          "position:absolute;left:100px;top:100px;width:160px;height:30px";
        const events: { trusted: boolean; detail: number }[] = [];
        Object.assign(window, { gestureEvents: events, presses: 0 });
        target.addEventListener(
          "mousedown",
          () =>
            Reflect.set(window, "presses", Reflect.get(window, "presses") + 1),
        );
        target.addEventListener("click", (event) => {
          events.push({ trusted: event.isTrusted, detail: event.detail });
          if (target.tagName === "BUTTON") {
            target.setAttribute("aria-expanded", "true");
          }
        });
        // Movement crosses animation frames while the locator's stability check runs.
        requestAnimationFrame(() => {
          target.style.top = "180px";
          requestAnimationFrame(() => {
            target.style.top = "240px";
          });
        });
      });
      const target = kind === "summary"
        ? page.getByText("Failure details", { exact: true })
        : page.getByRole("button", { name: "Error details" });
      const clickCount = kind === "summary" ? 1 : 2;
      await target.click({ clickCount });
      if (kind === "summary") {
        await expect(page.locator("details")).toHaveAttribute("open", "");
      } else await expect(target).toHaveAttribute("aria-expanded", "true");
      expect(
        await page.evaluate(() => Reflect.get(window, "gestureEvents")),
      ).toEqual(Array.from({ length: clickCount }, (_, i) => ({
        trusted: true,
        detail: i + 1,
      })));
      expect(await page.evaluate(() => Reflect.get(window, "presses"))).toBe(
        clickCount,
      );
      expect((await target.boundingBox())!.y).toBe(240);
    }
  },
);

for (const button of ["left", "right"] as const) {
  test(
    `harness.pointer-${button}-scroll`,
    { tag: ["@harness", "@contracts"] },
    async ({ page }) => {
      await page.setContent(
        '<button id="visible">Visible action</button><div id="pane" style="height:100px;overflow:auto;margin-top:20px"><div style="height:200px"></div><button id="clipped">Clipped action</button><div style="height:200px"></div></div>',
      );
      await page.evaluate((button) => {
        const gestures: { id: string; trusted: boolean }[] = [];
        Object.assign(window, { gestures });
        document.addEventListener(
          button === "left" ? "click" : "contextmenu",
          (event) => {
            event.preventDefault();
            gestures.push({
              id: (event.target as HTMLElement).id,
              trusted: event.isTrusted,
            });
          },
        );
      }, button);
      const initial = await page.locator("#pane").evaluate((el) =>
        el.scrollTop
      );
      await page.getByRole("button", { name: "Visible action" }).click({
        button,
      });
      expect(await page.locator("#pane").evaluate((el) => el.scrollTop)).toBe(
        initial,
      );
      await page.getByRole("button", { name: "Clipped action" }).click({
        button,
      });
      expect(await page.locator("#pane").evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      expect(await page.evaluate(() => Reflect.get(window, "gestures")))
        .toEqual([{ id: "visible", trusted: true }, {
          id: "clipped",
          trusted: true,
        }]);
    },
  );
}
