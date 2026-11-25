// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-visual-styles" });
for (const kind of ["question", "permission", "form"] as const) {
  test(`attention.${kind}-offline-dismissal-keeps-input-and-request`, {
    tag: ["@attention", "@messages", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.goto(`${state.url}/?scene=request-lifetime&kind=${kind}`);
    const selector = kind === "question"
      ? "textarea[name=question-answer]"
      : kind === "permission"
      ? 'input[aria-label="Reason for rejecting (optional)"]'
      : '[data-field="value"] input';
    const input = page.locator(selector);
    await input.fill("Keep my dirty input");
    await expect(page.locator("[data-dirty]")).toHaveAttribute(
      "data-dirty",
      "true",
    );
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await input.focus();
    await page.keyboard.press("Escape");
    if (kind === "question") await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Normal composer" }))
      .toBeVisible();
    const composer = page.getByRole("textbox", { name: "Normal composer" });
    await composer.click();
    await composer.fill("Independent composer draft");
    await expect(composer).toHaveValue("Independent composer draft");
    await expect(page.getByRole("button", { name: /Pending .*: reopen/ }))
      .toBeVisible();
    await expect(page.locator("[data-sent]")).toHaveAttribute("data-sent", "0");
    await page.getByRole("button", {
      name: "Reconnect with failed inventory",
      exact: true,
    }).click();
    await expect(page.getByRole("textbox", { name: "Normal composer" }))
      .toBeVisible();
    await page.getByRole("button", { name: /Pending .*: reopen/ }).click();
    await expect(input).toHaveValue("Keep my dirty input");
    await expect(page.locator("[data-dirty]")).toHaveAttribute(
      "data-dirty",
      "true",
    );
    if (kind === "question") {
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await page.evaluate(`styleTest.theme('${theme}')`);
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await info.attach(`request-lifetime-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    }
    await page.getByRole("button", { name: "Delete child", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "Normal composer" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: /Pending .*: reopen/ }))
      .toHaveCount(0);
    await expect(page.locator("[data-dirty]")).toHaveAttribute(
      "data-dirty",
      "false",
    );
  });
  test(`attention.${kind}-retirement-during-reply-restores-parent-composer`, {
    tag: ["@attention", "@messages", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/?scene=request-lifetime&kind=${kind}`);
    if (kind === "question") {
      await page.getByRole("button", { name: "Submit", exact: true }).click();
    } else {
      await page.locator("[data-primary-action]").click();
      if (kind === "form") await page.locator("[data-primary-action]").click();
    }
    await expect(page.locator("[data-sent]")).toHaveAttribute("data-sent", "1");
    await page.getByRole("button", { name: "Remove request", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "Normal composer" }))
      .toBeVisible();
    await expect(page.locator("[data-sent]")).toHaveAttribute("data-sent", "1");
  });
}
