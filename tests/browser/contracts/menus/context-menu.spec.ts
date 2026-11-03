// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  appActions,
  bounded,
  clipboard,
  contextMenu,
  copied,
  dismiss,
  menuLabels,
  pick,
  rightClick,
} from "../../pages/menus.ts";
test.use({ profile: "contract-menus-inbox" });

test("menus.trusted-context-keyboard-fallback-escape-corners-and-create", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  await rightClick(page, ".otk-tabs-project");
  expect(await menuLabels(page)).toEqual(appActions);
  for (
    const [key, name] of [
      ["End", "Display preferences"],
      ["Home", "New session"],
      ["ArrowUp", "Display preferences"],
      ["ArrowDown", "New session"],
      ["o", "Open command palette"],
    ]
  ) {
    await page.keyboard.press(key);
    await expect(contextMenu(page).getByRole("menuitem", { name, exact: true }))
      .toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Commands", exact: true }))
    .toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  for (const key of ["Shift+F10", "ContextMenu"]) {
    await page.evaluate("(document.activeElement).blur()");
    await page.keyboard.press(key);
    expect(await menuLabels(page)).toEqual(appActions);
    await dismiss(page);
    expect(await page.evaluate(() => document.activeElement === document.body))
      .toBe(true);
  }
  await page.evaluate(
    "document.querySelector('.otk-app').addEventListener('contextmenu',e=>globalThis.contextPrevented=e.defaultPrevented,{once:true})",
  );
  await page.locator(".otk-tabs-project").click({
    button: "right",
    modifiers: ["Shift"],
  });
  await expect.poll(() => page.evaluate("globalThis.contextPrevented")).toBe(
    false,
  );
  await expect(contextMenu(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  const { width, height } = page.viewportSize()!;
  for (
    const [x, y] of [[1, 1], [width - 1, 1], [1, height - 1], [
      width - 1,
      height - 1,
    ]]
  ) {
    await page.mouse.click(x, y, { button: "right" });
    await bounded(page);
    await dismiss(page);
  }
  await rightClick(page, ".otk-tabs-project");
  await pick(page, "Display preferences");
  const dialog = page.getByRole("dialog", {
    name: "Display preferences",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await rightClick(page, "dialog input[name=showCost]");
  await expect(contextMenu(page)).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    contextMenu(page).getByRole("menuitem", {
      name: "Display preferences",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    contextMenu(page).getByRole("menuitem", {
      name: "New session",
      exact: true,
    }),
  ).toBeFocused();
  await dismiss(page);
  await expect(dialog).toBeVisible();
  await expect.poll(() =>
    dialog.evaluate((el) => el.contains(document.activeElement))
  ).toBe(true);
  await dialog.locator("input[name=showCost]").click();
  await expect(dialog.locator("input[name=showCost]")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.locator(".otk-keys-entry").click();
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const before = (await state.observe<{ entries: unknown[] }>()).entries.length;
  const previous = page.url();
  await rightClick(page, ".otk-tabs-project");
  await pick(page, "New session");
  await expect(page).not.toHaveURL(previous);
  await expect(page.locator("textarea[name=prompt]")).toBeVisible();
  const entries =
    (await state.observe<{ entries: { id: string }[] }>()).entries;
  expect(entries).toHaveLength(before + 1);
  await expect(page).toHaveURL(new RegExp(entries.at(-1)!.id + "$"));
});

test("menus.semantic-links-images-selection-real-clipboard-and-popup", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  await clipboard(page);
  await page.evaluate(() => {
    const host = document.querySelector(".otk-welcome") ||
      document.querySelector(".otk-messages")!;
    const p = document.createElement("p");
    p.id = "context-probe";
    const link = document.createElement("a");
    link.href = location.origin + "/api/health";
    link.textContent = "Context link";
    p.append(link);
    const image = document.createElement("img");
    image.src =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="orange"/></svg>';
    image.alt = "Context image";
    p.append(image);
    host.prepend(p);
  });
  const tail = ["Pin as task", "Copy session title", "Close session"];
  await rightClick(page, "#context-probe a");
  expect(await menuLabels(page)).toEqual([
    "Open link in new tab",
    "Copy link address",
    ...tail,
  ]);
  await pick(page, "Copy link address");
  await copied(page, state.url + "/api/health");
  await rightClick(page, "#context-probe a");
  const popup = page.waitForEvent("popup");
  await pick(page, "Open link in new tab");
  const opened = await popup;
  await expect(opened).toHaveURL(state.url + "/api/health");
  await opened.close();
  await page.bringToFront();
  await rightClick(page, "#context-probe img");
  expect(await menuLabels(page)).toEqual([
    "Open image",
    "Copy image address",
    ...tail,
  ]);
  await pick(page, "Copy image address");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^data:image\/svg\+xml/);
  await rightClick(page, "#context-probe img");
  await pick(page, "Open image");
  const image = page.locator('dialog[open] img[alt="Context image"]');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute(
    "src",
    (await page.locator("#context-probe img").getAttribute("src"))!,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.evaluate(() =>
    document.querySelector("#context-probe a")!.append(
      document.querySelector("#context-probe img")!,
    )
  );
  await rightClick(page, "#context-probe img");
  expect(await menuLabels(page)).toEqual([
    "Open image",
    "Copy image address",
    "Open link in new tab",
    "Copy link address",
    ...tail,
  ]);
  await dismiss(page);
  await page.locator("#context-probe a").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  await rightClick(page, "#context-probe a");
  expect(await menuLabels(page)).toEqual([
    "Copy",
    "Open link in new tab",
    "Copy link address",
    ...tail,
  ]);
  await pick(page, "Copy");
  await copied(page, "Context link");
});
