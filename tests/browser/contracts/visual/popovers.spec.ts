// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
test.use({ profile: "contract-visual-inbox" });
const tags = { tag: ["@visual", "@isolated"] },
  menu = ':popover-open [role="menu"][aria-label="Context menu"]';
async function geometry(page: Page, selector: string, anchor?: string) {
  await expect(page.locator(selector)).toBeVisible();
  return await page.locator(selector).evaluate((el, anchor) => {
    const surface = el.closest(".otk-surface")!,
      panel = surface.closest(".otk-popover-panel")!,
      body = surface.querySelector(".otk-surface-body")!,
      r = surface.getBoundingClientRect(),
      clip = body.getBoundingClientRect();
    return {
      surface: r.toJSON(),
      panel: panel.getBoundingClientRect().toJSON(),
      anchor: anchor
        ? document.querySelector(anchor)!.getBoundingClientRect().toJSON()
        : null,
      body: { height: body.clientHeight, scroll: body.scrollHeight },
      viewport: { width: innerWidth, height: innerHeight },
      rows: Array.from(el.querySelectorAll("[role=menuitem]")).map((row) => {
        const t = row.getBoundingClientRect(),
          hit = document.elementFromPoint(
            t.x + t.width / 2,
            t.y + t.height / 2,
          );
        return {
          visible: t.width > 0 && t.height > 0 && t.left >= r.left &&
            t.right <= r.right && t.top >= clip.top && t.bottom <= clip.bottom,
          hit: !!hit && row.contains(hit),
        };
      }),
    };
  }, anchor);
}
function contained(g: Awaited<ReturnType<typeof geometry>>) {
  const r = g.surface;
  expect(r.width).toBeGreaterThan(0);
  expect(r.height).toBeGreaterThan(0);
  expect(g.body.height).toBeGreaterThan(0);
  expect(r.left).toBeGreaterThanOrEqual(-.5);
  expect(r.top).toBeGreaterThanOrEqual(-.5);
  expect(r.right).toBeLessThanOrEqual(g.viewport.width + .5);
  expect(r.bottom).toBeLessThanOrEqual(g.viewport.height + .5);
  for (const edge of ["left", "right", "top", "bottom"]) {
    expect(Math.abs(r[edge] - g.panel[edge])).toBeLessThanOrEqual(.5);
  }
  if (g.anchor) {
    const a = g.anchor;
    expect(
      r.bottom <= a.top + .5 || r.top >= a.bottom - .5 ||
        r.right <= a.left + .5 || r.left >= a.right - .5,
    ).toBe(true);
  }
}
async function close(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(":popover-open")).toHaveCount(0);
}
test(
  "visual.popover-body-fallback-native-create-and-point-rect-corners",
  tags,
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.locator(".otk-keys-entry").focus();
    await page.keyboard.press("ContextMenu");
    await expect(page.locator(menu + " [role=menuitem]").first()).toBeFocused();
    contained(await geometry(page, menu));
    await close(page);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press("ContextMenu");
    let g = await geometry(page, menu);
    contained(g);
    expect(g.rows.length).toBeGreaterThan(0);
    expect(g.rows.every((row) => row.visible && row.hit)).toBe(true);
    const before =
      (await state.observe<{ entries: unknown[] }>()).entries.length;
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
    ).toHaveText("New session");
    expect((await state.observe<{ entries: unknown[] }>()).entries)
      .toHaveLength(before + 1);
    const size = page.viewportSize()!;
    for (
      const [x, y] of [[1, 1], [size.width - 1, 1], [1, size.height - 1], [
        size.width - 1,
        size.height - 1,
      ]]
    ) {
      await page.mouse.click(x, y, { button: "right" });
      await expect(page.locator(menu)).toBeFocused();
      g = await geometry(page, menu);
      contained(g);
      expect(g.rows.length).toBeGreaterThan(0);
      expect(g.rows.every((row) => row.visible && row.hit)).toBe(true);
      await close(page);
    }
    for (
      const edges of [
        "left:0;top:0",
        "right:0;top:0",
        "left:0;bottom:0",
        "right:0;bottom:0",
      ]
    ) {
      await page.locator(".otk-tabs-project").evaluate((el, edges) => {
        const node = el as HTMLElement;
        node.tabIndex = 0;
        node.style.cssText = "position:fixed;width:160px;height:40px;" + edges;
        node.focus();
      }, edges);
      await page.keyboard.press("ContextMenu");
      await expect(page.locator(menu + " [role=menuitem]").first())
        .toBeFocused();
      g = await geometry(page, menu, ".otk-tabs-project");
      contained(g);
      expect(g.rows.length).toBeGreaterThan(0);
      expect(g.rows.every((row) => row.visible && row.hit)).toBe(true);
      await close(page);
    }
  },
);
test(
  "visual.tall-anchored-surface-native-side-scroll-and-last-hitbox",
  tags,
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await page.evaluate(() => document.fonts.ready.then(() => true));
    for (const [width, height] of [[1280, 657], [720, 360]]) {
      await page.setViewportSize({ width, height });
      for (
        const position of [{ top: "50%", bottom: "auto" }, {
          top: "0",
          bottom: "auto",
        }, { top: "auto", bottom: "0" }]
      ) {
        await page.locator(".otk-display-menu > button").evaluate(
          (el, position) => {
            Object.assign((el as HTMLElement).style, {
              position: "fixed",
              left: "50%",
              ...position,
            });
            (el as HTMLElement).focus();
          },
          position,
        );
        // The synthetic rect can be painted under the composer at narrow
        // widths. Native keyboard activation preserves the focused anchor and
        // leaves the Surface's positioning/last-control hit tests unchanged.
        await page.keyboard.press("Enter");
        const g = await geometry(
          page,
          ".otk-display-menu :popover-open .otk-display-preferences",
          ".otk-display-menu > button",
        );
        contained(g);
        expect(g.body.scroll).toBeGreaterThan(g.body.height);
        await page.locator(".otk-display-menu :popover-open .otk-surface-body")
          .evaluate((el) => el.scrollTop = el.scrollHeight);
        expect(
          await page.locator(
            ".otk-display-menu :popover-open input[name=animationsOff]",
          ).evaluate((input) => {
            const r = input.getBoundingClientRect(),
              hit = document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              );
            return !!hit && (hit === input || input.contains(hit));
          }),
        ).toBe(true);
        await close(page);
      }
    }
  },
);
