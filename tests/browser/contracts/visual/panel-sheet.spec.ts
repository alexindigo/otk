// SPDX-License-Identifier: LGPL-3.0-only
import { type Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { acquireOlderHistory } from "../../pages/history.ts";
import { scrollTranscript, wheelTranscript } from "../../pages/transcript.ts";

const tags = { tag: ["@visual", "@isolated"] };
const narrow = { width: 720, height: 800 };
const wide = { width: 1280, height: 800 };
const back = (page: Page) =>
  page.getByRole("button", { name: "Back to conversation", exact: true });
const stage = (page: Page) => page.locator(".otk-stage");

test.use({ profile: "contract-messages-window" });

test(
  "visual.panel-sheet.conversation-actions",
  tags,
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await page.setViewportSize(narrow);
    await expect(back(page)).toBeVisible();
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    const row = page.locator("[data-timeline-prompt]").first();
    const id = await row.getAttribute("data-timeline-prompt");
    await row.locator(".otk-timeline-reveal").click();
    await expect(back(page)).toHaveCount(0);
    await expect(page.locator(`[data-message="${id}"] .otk-user-bubble`))
      .toBeFocused();

    await page.getByRole("button", { name: "Open right panel", exact: true })
      .click();
    await expect(back(page)).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("region", { name: "Settings", exact: true }))
      .toBeVisible();
    await expect(back(page)).toHaveCount(0);
  },
);

test(
  "visual.panel-sheet.narrow",
  tags,
  async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await acquireOlderHistory(page, 105);
    await state.product("layout.patch", { rightCollapsed: true });
    await page.setViewportSize(narrow);
    const main = page.locator(".otk-main");
    const panel = page.getByRole("complementary", {
      name: "Right panel",
      exact: true,
    });
    const origin = page.locator(".otk-display-menu > button");
    const prompt = page.locator("textarea[name=prompt]");
    const scroll = () =>
      page.locator(".otk-messages").evaluate((el) => el.scrollTop);

    // A broadcast opens the same layout state that future conversation controls
    // will request. It must move focus even without a local panel click.
    await scrollTranscript(page, true);
    await wheelTranscript(page, -900);
    await expect.poll(scroll).toBeGreaterThan(0);
    await origin.focus();
    await expect(origin).toBeFocused();
    const before = await scroll();
    await state.product("layout.patch", { rightCollapsed: false });
    await expect(stage(page)).toHaveClass(/\bis-sheet\b/);
    await expect(main).toHaveAttribute("inert", "");
    await expect(panel.getByRole("heading", { name: "Sessions", exact: true }))
      .toBeVisible();
    await expect(panel.getByRole("separator", { name: "Right panel width" }))
      .toHaveCount(0);
    await expect(panel.locator("header :is(button, [role=tab])").first())
      .toHaveAccessibleName("Back to conversation");
    await expect(back(page)).toBeFocused();

    const overlay = (await panel.boundingBox())!,
      conversation = (await main.boundingBox())!;
    for (const edge of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(overlay[edge] - conversation[edge])).toBeLessThanOrEqual(
        1,
      );
    }
    await back(page).hover();
    const label = await back(page).evaluate((button) => {
      const content = document.createRange();
      content.selectNodeContents(button.querySelector(".otk-control-label")!);
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      const text = content.getBoundingClientRect();
      return {
        lines: content.getClientRects().length,
        left: icon.left - box.left,
        right: box.right - text.right,
        padding: parseFloat(getComputedStyle(button).paddingInlineStart),
      };
    });
    expect(label.lines).toBe(1);
    expect(label.padding).toBeGreaterThan(0);
    expect(Math.min(label.left, label.right)).toBeGreaterThanOrEqual(
      label.padding - 1,
    );
    expect(Math.abs(label.left - label.right)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Enter");
    await expect(page.locator(".otk-right-rail")).toBeVisible();
    await expect(main).not.toHaveAttribute("inert");
    await expect(origin).toBeFocused();
    await expect.poll(scroll).toBe(before);

    // A rail tab is retired when the panel opens. Return to the composer if
    // that opening control no longer exists, even with the projects rail shown.
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Expand projects", exact: true }),
    ).toBeVisible();
    await page.locator('.otk-right-rail [data-panel-view="sessions"]').click();
    await expect(stage(page)).toHaveClass(/\bis-sheet\b/);
    await expect(back(page)).toBeFocused();
    await back(page).click();
    await expect(prompt).toBeFocused();
  },
);

test(
  "visual.panel-sheet.wide",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.setViewportSize(wide);
    await openSession(state, page, "tstv1-otk");
    const main = page.locator(".otk-main"),
      panel = page.locator(".otk-right-panel");
    const a = (await main.boundingBox())!, b = (await panel.boundingBox())!;
    expect(Math.abs(a.x + a.width - b.x)).toBeLessThanOrEqual(1);
    await expect(main).not.toHaveAttribute("inert");
    await expect(back(page)).toHaveCount(0);
    await expect(panel.getByRole("separator", { name: "Right panel width" }))
      .toBeVisible();
  },
);

test(
  "visual.panel-sheet.resize",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.setViewportSize(wide);
    const { sent } = await wire(page);
    await openSession(state, page, "tstv1-otk");
    const before = (await state.product("prefs.get", {})).shellLayout;
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.focus();
    await page.setViewportSize(narrow);
    await expect(stage(page)).toHaveClass(/\bis-sheet\b/);
    await expect(back(page)).toBeFocused();
    await page.setViewportSize({ ...wide, width: 1024 });
    await expect(stage(page)).not.toHaveClass(/\bis-sheet\b/);
    await expect(prompt).toBeFocused();

    // The minimum is a computed theme length, not a fixed CSS-pixel threshold.
    await state.product("prefs.set", { key: "textSize", value: "125" });
    await expect(stage(page)).toHaveClass(/\bis-sheet\b/);
    await page.setViewportSize(wide);
    await expect(stage(page)).not.toHaveClass(/\bis-sheet\b/);
    expect(sent.filter(({ frame }) => frame.method === "layout.patch")).toEqual(
      [],
    );
    expect((await state.product("prefs.get", {})).shellLayout).toEqual(before);
  },
);
