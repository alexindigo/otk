// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });

test("composer.select-exposes-keyboard-candidate", {
  tag: ["@composer", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/?picker-lifetime`);
  const trigger = page.getByRole("button", { name: "Choice: Alpha" });
  await trigger.click();
  const list = page.getByRole("listbox", { name: "Choice" });
  await expect(list).toBeFocused();
  const active = () =>
    list.evaluate((el) =>
      document.getElementById(el.getAttribute("aria-activedescendant") ?? "")
        ?.textContent?.trim()
    );
  await expect.poll(active).toBe("Alpha");
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe("Gamma");
  await expect(list.getByRole("option", { name: "Alpha" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(page.locator('input[name="choice"]')).toHaveValue("gamma");
  await expect(page.getByRole("button", { name: "Choice: Gamma" }))
    .toBeFocused();
});
