// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Locator, type Page } from "@playwright/test";
export const contextMenu = (page: Page) =>
  page.locator(':popover-open [role="menu"][aria-label="Context menu"]');
/** Registry names are public identities; mounted command IDs are opaque. */
export const contextCommand = (menu: Locator, name: string) =>
  menu.locator(`[data-context-command-name=${JSON.stringify(name)}]`);
export const paletteCommand = (page: Page, name: string) =>
  page.locator(`[data-command-name=${JSON.stringify(name)}]`);
export const appActions = [
  "New session",
  "Open command palette",
  "Display preferences",
];
export const sessionActions = [
  "Pin as task",
  "Copy session title",
  "Close session",
];
export const panelActions = [
  "New session",
  "Find a session",
  "Collapse right panel",
];
/** An open native shell can precede its reactive action projection. Geometry
 * baselines belong to the complete visible menu, not that intermediate shell.
 */
export async function readyMenuBox(panel: Locator, labels: string[]) {
  const items = panel.getByRole("menuitem");
  await expect(items).toHaveText(labels);
  for (const item of await items.all()) await expect(item).toBeVisible();
  return (await panel.boundingBox())!;
}
/** Keyboard opening must paint a real ring on the focused, visible item. */
export async function keyboardItem(item: Locator) {
  await expect(item).toBeFocused();
  await expect.poll(() =>
    item.evaluate((el) => {
      const style = getComputedStyle(el);
      return el.matches(":focus-visible") && style.outlineStyle === "solid" &&
        parseFloat(style.outlineWidth) > 0;
    })
  ).toBe(true);
}
export async function menuLabels(page: Page) {
  await expect(contextMenu(page)).toBeVisible();
  return contextMenu(page).getByRole("menuitem").allTextContents();
}
export async function groups(page: Page) {
  await expect(contextMenu(page)).toBeVisible();
  return contextMenu(page).locator(":scope > [role=group]").evaluateAll(
    (elements) =>
      elements.map((group) =>
        Array.from(group.querySelectorAll("button"), (item) => item.textContent)
      ),
  );
}
export async function pick(page: Page, name: string) {
  await contextMenu(page).getByRole("menuitem", { name, exact: true }).click();
}
export async function dismiss(page: Page) {
  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);
}
export async function rightClick(
  page: Page,
  target: string | Locator,
  empty = false,
) {
  const locator = typeof target === "string" ? page.locator(target) : target;
  if (!empty) {
    await locator.click({ button: "right" });
    return;
  }
  // Area commands require actual empty space, not a descendant target's center.
  const point = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (const y of [r.bottom - 12, r.y + r.height / 2, r.y + 12]) {
      for (let x = r.x + 8; x < r.right - 4; x += 16) {
        const hit = document.elementFromPoint(x, y);
        if (
          hit && el.contains(hit) &&
          !hit.closest(
            "[data-message],[data-project],[data-session],input,textarea,button,a,img",
          )
        ) {
          return { x: x - r.x, y: y - r.y };
        }
      }
    }
    throw Error("No empty area point");
  });
  await locator.click({ button: "right", position: point });
}
export async function copied(page: Page, value: string) {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(value);
}
export async function clipboard(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
}
export async function bounded(page: Page) {
  await expect.poll(() =>
    contextMenu(page).evaluate((el) => {
      const r = el.closest(".otk-surface")!.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5;
    })
  ).toBe(true);
}
