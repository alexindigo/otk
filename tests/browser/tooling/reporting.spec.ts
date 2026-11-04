// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "@playwright/test";
test(
  "reporting.controlled-first-attempt-failure",
  { tag: "@harness" },
  async ({ page }, info) => {
    await page.setContent("<main>First attempt evidence canary</main>");
    await expect(page.getByRole("main")).toHaveText(
      "First attempt evidence canary",
    );
    expect(info.retry, "controlled first attempt failure").toBe(1);
  },
);
