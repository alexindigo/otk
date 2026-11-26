// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test.use({ profile: "revert-native", viewport: { width: 1280, height: 800 } });

async function geometry(row: Locator) {
  const facts = await row.evaluate((node) => {
    const rect = (selector: string) =>
      node.querySelector(selector)
        ?.getBoundingClientRect();
    const ruler = document.createElement("span");
    ruler.style.position = "absolute";
    node.append(ruler);
    const token = (name: string) => {
      ruler.style.width = `var(${name})`;
      return ruler.getBoundingClientRect().width;
    };
    const height = token("--tree-row-height"), gap = token("--space-2");
    ruler.remove();
    const heading = node.getBoundingClientRect();
    const label = rect(".otk-record-row-label, .otk-record-group-toggle")!;
    const icon = rect(".otk-tree-icon")!;
    const actions = rect(".otk-record-row-actions, .otk-fitted-actions")!;
    const status = rect(".otk-record-row-status");
    const buttons = Array.from(
      node.querySelectorAll(".otk-fitted-actions button"),
    )
      .map((button) => button.getBoundingClientRect()).filter((r) => r.width);
    return {
      height,
      gap,
      actualHeight: heading.height,
      align: Math.abs(actions.right - heading.right),
      iconGap: label.left - icon.right,
      statusGap: status?.width ? actions.left - status.right : undefined,
      buttonOffsets: buttons.map((r) => Math.abs(r.top - label.top)),
    };
  });
  expect.soft(facts.actualHeight).toBeLessThanOrEqual(facts.height + 1);
  expect.soft(facts.align).toBeLessThanOrEqual(0.5);
  expect.soft(Math.abs(facts.iconGap - facts.gap)).toBeLessThanOrEqual(0.5);
  if (facts.statusGap !== undefined) {
    expect.soft(Math.abs(facts.statusGap - facts.gap)).toBeLessThanOrEqual(1);
  }
  expect(facts.buttonOffsets.length).toBeGreaterThan(0);
  for (const offset of facts.buttonOffsets) {
    expect.soft(offset).toBeLessThanOrEqual(1);
  }
}

test("revert.record-row-one-line-through-copy-and-disclosure-states", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Record row geometry",
  });
  await openSession(state, page, source.id);
  await state.queue(["The reply has been saved."]);
  await prompt(
    page,
    "Review this long source prompt before making changes to the code and restoring the conversation",
  );
  await expect(page.locator(".otk-messages")).toContainText(
    "The reply has been saved.",
  );
  await expect(page.locator(`.otk-session-row[data-session="${source.id}"]`))
    .toHaveAttribute("data-status", "idle");
  const group = page.locator(".otk-revert-group");
  const row = group.locator(".otk-record-group-heading").first();
  const restore = group.getByRole("button", { name: "Restore conversation" });
  const toggle = group.locator(".otk-record-group-toggle").first();
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Reflect.set(window, "recordGeometryStorage", write);
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("otk.branch-history")) {
        throw new DOMException("Storage is full", "QuotaExceededError");
      }
      write.call(this, key, value);
    };
  });
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(group).toHaveAttribute("data-phase", "failed");
  async function matrix() {
    for (const [width, scale] of [[1280, "100"], [900, "125"]] as const) {
      await page.setViewportSize({ width, height: 800 });
      await state.product("prefs.set", { key: "textSize", value: scale });
      await expect.poll(() =>
        page.locator("html").evaluate((html) =>
          Number(getComputedStyle(html).getPropertyValue("--otk-scale"))
        )
      ).toBe(Number(scale) / 100);
      for (
        const theme of ["otk-dark", "otk-light", "otk-light-stone"] as const
      ) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await geometry(row);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await state.product("prefs.set", { key: "textSize", value: "100" });
  }
  await matrix();
  await page.evaluate(() => {
    Storage.prototype.setItem = Reflect.get(window, "recordGeometryStorage");
  });
  await group.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(group).toHaveAttribute("data-phase", "saved");
  await matrix();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await matrix();
  await restore.hover();
  const padding = await restore.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const label = range.getBoundingClientRect(),
      button = node.getBoundingClientRect();
    const ruler = document.createElement("span");
    ruler.style.cssText = "position:absolute;inline-size:var(--space-2)";
    node.append(ruler);
    const minimum = ruler.getBoundingClientRect().width;
    ruler.remove();
    return {
      left: label.left - button.left,
      right: button.right - label.right,
      minimum,
    };
  });
  expect(Math.abs(padding.left - padding.right)).toBeLessThanOrEqual(1);
  expect(Math.min(padding.left, padding.right)).toBeGreaterThanOrEqual(
    padding.minimum - 0.5,
  );
  await group.getByRole("button", { name: "Open copy", exact: true }).click();
  await page.getByRole("button", { name: "Delete saved branch", exact: true })
    .click();
  await expect(group).toHaveAttribute("data-phase", "staged");
  await expect(group.getByRole("button", { name: "Save copy", exact: true }))
    .toBeVisible();
  await matrix();
});
