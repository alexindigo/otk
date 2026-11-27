// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/evidence.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";
import { cleanup, open, viewport } from "../../pages/terminal.ts";

const tags = { tag: "@composer" };
const transcript = (page: Page) =>
  page.getByRole("region", { name: "Transcript", exact: true });
const bodyFocused = () => document.activeElement === document.body;

async function openComposer(state: TestState, page: Page) {
  const text = "Keep this transcript text selected";
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Return to OTK",
    messages: [{ parts: [{ type: "text", text }] }],
  });
  await openSession(state, page, session.id);
  return text;
}

async function returnToWindow(page: Page, loseElementFocus = true) {
  // Playwright forces page focus. Deliver the window events independently of
  // visibility and exercise real browser blur, selection and focus underneath.
  return await page.evaluate((blur) => {
    globalThis.dispatchEvent(new FocusEvent("blur"));
    if (blur) (document.activeElement as HTMLElement)?.blur();
    const wasBody = document.activeElement === document.body;
    globalThis.dispatchEvent(new FocusEvent("focus"));
    return wasBody;
  }, loseElementFocus);
}

test("composer.window-focus-restores-empty-document-with-draft", tags, async ({
  state,
  page,
}) => {
  await openComposer(state, page);
  const input = prompt(page);
  const draft = "An unsent draft";
  await input.fill(draft);
  await input.press("Home");
  expect(
    await input.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
  ).toBe(0);
  const scrollTop = await transcript(page).evaluate((node) => node.scrollTop);
  expect(await returnToWindow(page)).toBe(true);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(draft);
  expect(
    await input.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  )
    .toEqual([draft.length, draft.length]);
  expect(await transcript(page).evaluate((node) => node.scrollTop)).toBe(
    scrollTop,
  );
});

test("composer.window-focus-restores-on-visible", tags, async ({
  state,
  page,
}) => {
  await openComposer(state, page);
  expect(await page.evaluate(bodyFocused)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });
  expect(await page.evaluate(bodyFocused)).toBe(true);
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(prompt(page)).toBeFocused();
});

test("composer.window-focus-restores-terminal", {
  tag: ["@composer", "@terminal"],
}, async ({ state, page }) => {
  const id = await open(state, page, "Return to the terminal");
  try {
    await viewport(page).click({ position: { x: 8, y: 8 } });
    const terminal = page.getByRole("textbox", { name: "Terminal input" });
    await expect(terminal).toBeFocused();
    expect(await returnToWindow(page)).toBe(true);
    await expect(terminal).toBeFocused();
    await expect(prompt(page)).not.toBeFocused();
  } finally {
    await cleanup(state, id);
  }
});

test("composer.window-focus-search-only-with-open-session", tags, async ({
  state,
  page,
}) => {
  await openComposer(state, page);
  const search = page.getByRole("searchbox", {
    name: "Search sessions by title",
  });
  await search.focus();
  expect(await returnToWindow(page)).toBe(true);
  await expect(search).toBeFocused();

  await page.keyboard.press("Control+k");
  await page.locator('[data-command="session.close"]').click();
  await expect(prompt(page)).toHaveCount(0);
  await search.focus();
  await expect(search).toBeFocused();
  expect(await returnToWindow(page)).toBe(true);
  expect(await page.evaluate(bodyFocused)).toBe(true);
});

test("composer.window-focus-keeps-dialog", tags, async ({ state, page }) => {
  await openComposer(state, page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Commands", exact: true });
  const search = dialog.getByRole("textbox", { name: "Find a command" });
  await expect(search).toBeFocused();
  await returnToWindow(page, false);
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
});

test("composer.window-focus-keeps-menu", tags, async ({ state, page }) => {
  await openComposer(state, page);
  await transcript(page).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  expect(await returnToWindow(page)).toBe(true);
  await expect(menu).toBeVisible();
  expect(await page.evaluate(bodyFocused)).toBe(true);
});

test("composer.window-focus-keeps-transcript-selection", tags, async ({
  state,
  page,
}) => {
  const text = await openComposer(state, page);
  await transcript(page).getByText(text, { exact: true }).evaluate((node) => {
    document.getSelection()!.selectAllChildren(node);
  });
  expect(await returnToWindow(page)).toBe(true);
  expect(await page.evaluate(() => document.getSelection()!.toString())).toBe(
    text,
  );
  expect(await page.evaluate(bodyFocused)).toBe(true);
});
