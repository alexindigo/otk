// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { prompt } from "../../pages/composer.ts";

for (const phase of ["initial-load", "reload", "focused", "after-editor"]) {
  test(`composer.attachment-picker-first-click-${phase}`, {
    tag: "@composer",
  }, async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Attachment picker",
    });
    await page.goto(`${state.url}/#/local/${session.id}`);
    const attach = page.getByRole("button", {
      name: "Attach files",
      exact: true,
    });
    if (phase === "reload") {
      await expect(attach).toBeVisible();
      await page.reload();
    } else if (phase === "focused") {
      await prompt(page).click();
      await expect(prompt(page)).toBeFocused();
    } else if (phase === "after-editor") {
      await page.getByRole("button", { name: "Edit prompt", exact: true })
        .click();
      const editor = page.getByRole("dialog", { name: "Edit prompt" });
      await expect(editor).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden();
    }

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5000 }),
      attach.click(),
    ]);
    await chooser.setFiles({
      name: "first-click.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("first-click attachment"),
    });
    await expect(page.getByTitle("first-click.txt", { exact: true }))
      .toBeVisible();
  });
}

test("composer.attachment-picker-first-click-through-toolbar-refit", {
  tag: "@composer",
}, async ({ state, page }) => {
  await page.setViewportSize({ width: 690, height: 800 });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: true,
    leftWidth: 360,
  });
  await state.product("prefs.set", { key: "textSize", value: "150" });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Attachment picker in More actions",
  });
  await page.goto(`${state.url}/#/local/${session.id}`);
  const more = page.getByRole("button", { name: "More actions", exact: true });
  await more.click();
  const menu = page.getByRole("menu", { name: "More actions", exact: true });
  const attach = menu.getByRole("menuitem", {
    name: "Attach files",
    exact: true,
  });
  await expect(attach).toBeVisible();
  const { x, y } = await attach.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(x, y);
  await page.mouse.down();

  // A layout update frees space for the toolbar icons during this one click.
  // Measure the new fit before releasing, without moving the pointer.
  await state.product("layout.patch", { leftWidth: 280 });
  await expect(page.getByRole("separator", { name: "Project column width" }))
    .toHaveAttribute("aria-valuenow", "280");
  expect(
    await attach.evaluate(async (el, { x, y }) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return el.contains(document.elementFromPoint(x, y));
    }, { x, y }),
  ).toBe(true);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }),
    page.mouse.up(),
  ]);
  await chooser.setFiles([]);
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Attach files", exact: true }))
    .toBeVisible();
});
