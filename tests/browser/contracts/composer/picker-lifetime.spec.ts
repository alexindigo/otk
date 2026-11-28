// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });

for (const search of [false, true]) {
  for (const scenario of ["removed", "surviving"] as const) {
    test(`composer.picker-lifetime-${scenario}-${search ? "search" : "root"}`, {
      tag: ["@composer", "@contracts"],
    }, async ({ isolatedState: state, page }) => {
      const url = new URL(state.url);
      url.searchParams.set("picker-lifetime", "");
      if (search) url.searchParams.set("search", "");
      await page.goto(url.href);
      await page.getByRole("button", { name: "Live catalog", exact: true })
        .click();
      const option = (key: string) =>
        page.locator(`[data-picker-key="${key}"] .otk-picker-option`);
      const fallback = search
        ? page.getByRole("combobox", { name: "Search live catalog" })
        : page.locator(
          ".otk-picker-content, .otk-picker-content [role=listbox]",
        )
          .and(page.locator(":focus"));
      await expect(option("alpha")).toBeVisible();
      if (scenario === "surviving") {
        await option("beta").focus();
        await option("beta").evaluate((el) =>
          el.dataset.consumerNode = "retained"
        );
        await page.locator("[data-update-picker]").evaluate((
          el: HTMLButtonElement,
        ) => el.click());
        await expect(option("beta")).toHaveText("Beta updated");
        await expect(option("beta")).toHaveAttribute(
          "data-consumer-node",
          "retained",
        );
        await expect(option("beta")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("[data-picked]")).toHaveText("updated beta");
        return;
      }
      await option("alpha").focus();
      await page.locator("[data-remove-picker]").evaluate((
        el: HTMLButtonElement,
      ) => el.click());
      await expect(page.locator('[data-picker-key="alpha"]')).toHaveCount(0);
      await expect(fallback).toBeFocused();
      await expect(option("beta")).toBeVisible();
      await option("beta").focus();
      await page.locator("[data-empty-picker]").evaluate((
        el: HTMLButtonElement,
      ) => el.click());
      await expect(page.getByRole("option")).toHaveCount(0);
      await expect(fallback).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-picked]")).toHaveText("");
      await expect(page.locator(".otk-picker-empty")).toHaveText(
        "No options available.",
      );
    });
  }
}
