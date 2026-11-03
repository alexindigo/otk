// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-visual-provider-ports" });
test("visual.public-provider-ports-live-copy-and-construction-lifetime", {
  tag: ["@visual", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url + "/?theme=otk-dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );
  await expect(page.locator("#mounts")).toHaveText("1");
  await expect(page.locator("#port-keys")).toHaveText(
    "commands,failureOwned,keyboard",
  );
  for (const id of ["identity", "keyboard", "failure-owned"]) {
    await expect(page.locator("#" + id)).toHaveText("true");
  }
  await page.locator("#copy-ports").click();
  await expect(page.locator("#copied")).toHaveText("0");
  await expect(page.locator("#mounts")).toHaveText("1");
  await page.locator("#replace-ports").click();
  for (const id of ["identity", "keyboard", "failure-owned"]) {
    await expect(page.locator("#" + id)).toHaveText("true");
  }
  await page.locator("#copy-ports").click();
  await expect(page.locator("#copied")).toHaveText("1");
  await expect(page.locator("#mounts")).toHaveText("1");
  await page.locator("#toggle-consumer").click();
  await expect(page.locator("#consumer")).toHaveCount(0);
  await expect(page.locator("#releases")).toHaveText("1");
  await page.locator("#toggle-consumer").click();
  await expect(page.locator("#mounts")).toHaveText("2");
  await expect(page.locator("#consumer")).toHaveAttribute(
    "data-construction",
    "2",
  );
  await expect(page.locator("#releases")).toHaveText("1");
});
