// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-sessions-catalog" });
test(
  "sessions.discovered-disclosure-accepts-both-boolean-intents-and-persists",
  {
    tag: ["@sessions", "@contracts"],
  },
  async ({ isolatedState: state, page }) => {
    const { root } = await state.observe<{ root: string }>();
    const header = page.getByRole("button", {
      name: "Discovered projects, 1",
      exact: true,
    });
    const row = page.locator(
      `.otk-project-row[data-project=${
        JSON.stringify(root + "/projects/empty")
      }]`,
    );
    await page.goto(state.url);
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(row).toBeVisible();
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(row).toHaveCount(0);
    await header.focus();
    await page.keyboard.press("ArrowRight");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(row).toBeVisible();
    await page.reload();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(row).toBeVisible();
  },
);
