// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-public-ui" });
test(
  "messages.shared-scrollbar-proportional-drag-wheel-keyboard-and-lifetime",
  {
    tag: ["@messages", "@contracts", "@scroll"],
  },
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?scrollbars");
    const region = page.getByRole("region", {
      name: "Scroll probe",
      exact: true,
      includeHidden: true,
    });
    const frame = region.locator("..");
    const y = frame.locator(":scope > .otk-scroll-track-y");
    const x = frame.locator(":scope > .otk-scroll-track-x");
    const top = () => region.evaluate((element) => element.scrollTop);
    await expect(y).toBeVisible();
    await expect(x).toBeVisible();
    await expect(page.locator("[data-scroll-content]")).toHaveAttribute(
      "data-mounts",
      "1",
    );
    for (const axis of ["y", "x"] as const) {
      const track = axis === "y" ? y : x;
      const thumb = track.locator(".otk-scroll-thumb");
      const geometry = await region.evaluate((element, axis) => {
        const track = element.parentElement!.querySelector(
          `.otk-scroll-track-${axis}`,
        )!;
        const r = track.getBoundingClientRect(),
          t = track.firstElementChild!.getBoundingClientRect();
        const viewport = axis === "y"
          ? element.clientHeight
          : element.clientWidth;
        const content = axis === "y"
          ? element.scrollHeight
          : element.scrollWidth;
        return {
          length: axis === "y" ? r.height : r.width,
          size: axis === "y" ? t.height : t.width,
          center: axis === "y"
            ? Math.abs(t.x + t.width / 2 - r.x - r.width / 2)
            : Math.abs(t.y + t.height / 2 - r.y - r.height / 2),
          viewport,
          content,
        };
      }, axis);
      expect(
        Math.abs(
          geometry.size -
            geometry.length * geometry.viewport / geometry.content,
        ),
      ).toBeLessThanOrEqual(1);
      expect(geometry.center).toBeLessThanOrEqual(1);
      await track.hover();
      const box = (await thumb.boundingBox())!;
      const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      const displacement = (geometry.length - geometry.size) * .375;
      await page.mouse.move(
        start.x + (axis === "x" ? displacement : 0),
        start.y + (axis === "y" ? displacement : 0),
        { steps: 6 },
      );
      await page.mouse.up();
      const expected = (geometry.content - geometry.viewport) * .375;
      await expect.poll(async () =>
        Math.abs(
          await region.evaluate(
            (element, axis) =>
              axis === "y" ? element.scrollTop : element.scrollLeft,
            axis,
          ) - expected,
        )
      ).toBeLessThanOrEqual(1);
    }
    const trackBox = (await y.boundingBox())!;
    await page.mouse.click(
      trackBox.x + trackBox.width / 2,
      trackBox.y + trackBox.height - 1,
    );
    await expect.poll(top).toBe(800);
    await y.hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(top).toBe(680);
    await region.hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(top).toBe(560);
    await region.focus();
    await page.keyboard.press("Home");
    await expect.poll(top).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(top).toBe(800);
    await page.getByRole("button", { name: "Toggle region" }).focus();
    await page.mouse.move(900, 700);
    await expect.poll(() =>
      y.evaluate((element) => Number(getComputedStyle(element).opacity))
    ).toBe(0);
    await region.hover();
    await expect.poll(() =>
      y.evaluate((element) => Number(getComputedStyle(element).opacity))
    ).toBe(1);
    await page.getByRole("button", { name: "Toggle region" }).click();
    await expect(region).toBeHidden();
    expect(await frame.evaluate((element) => element.getClientRects().length))
      .toBe(0);
    await page.getByRole("button", { name: "Toggle region" }).click();
    await expect(region).toBeVisible();
    await expect(page.locator("[data-scroll-content]")).toHaveAttribute(
      "data-mounts",
      "1",
    );
  },
);
