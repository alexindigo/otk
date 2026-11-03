// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { contextMenu, rightClick } from "../../pages/menus.ts";

test.use({ profile: "contract-menus-inbox" });
test("menus.native-text-context-trusted-pointer-and-keyboard-passthrough", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  await page.locator("textarea[name=prompt]").fill(
    "Speling stays with the browser",
  );
  await page.evaluate(() => {
    const owner = globalThis as unknown as {
      nativeContext?: { prevented: boolean; trusted: boolean };
      nativeKey?: { prevented: boolean; trusted: boolean };
    };
    document.addEventListener(
      "contextmenu",
      (e) =>
        owner.nativeContext = {
          prevented: e.defaultPrevented,
          trusted: e.isTrusted,
        },
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "ContextMenu" || e.key === "F10") {
        owner.nativeKey = {
          prevented: e.defaultPrevented,
          trusted: e.isTrusted,
        };
      }
    }, true);
  });
  const native = async (selector: string) => {
    await page.evaluate("globalThis.nativeContext=undefined");
    await rightClick(page, selector);
    await expect.poll(() => page.evaluate("globalThis.nativeContext")).toEqual({
      prevented: false,
      trusted: true,
    });
    await expect(contextMenu(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator(selector).click();
    for (const key of ["ContextMenu", "Shift+F10"]) {
      await page.evaluate("globalThis.nativeKey=undefined");
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate("globalThis.nativeKey")).toEqual({
        prevented: false,
        trusted: true,
      });
      await expect(contextMenu(page)).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
  };
  await native("textarea[name=prompt]");
  await native('input[placeholder="Find a session"]');
  for (
    const type of [
      "text",
      "search",
      "email",
      "password",
      "url",
      "tel",
      "number",
    ]
  ) {
    await page.evaluate((type) => {
      const el = document.createElement("input");
      el.id = "native-field";
      el.type = type;
      el.value = "123";
      document.querySelector(".otk-messages")!.prepend(el);
    }, type);
    await native("#native-field");
    await page.locator("#native-field").evaluate((el) => el.remove());
  }
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "native-edit";
    el.contentEditable = "true";
    el.innerHTML = "<span>Editable spelling</span>";
    document.querySelector(".otk-messages")!.prepend(el);
  });
  await native("#native-edit span");
  await page.locator("#native-edit span").evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  await native("#native-edit span");
  await rightClick(page, ".otk-tabs-project");
  await expect(contextMenu(page)).toBeVisible();
  expect(await page.evaluate("globalThis.nativeContext")).toEqual({
    prevented: true,
    trusted: true,
  });
});
