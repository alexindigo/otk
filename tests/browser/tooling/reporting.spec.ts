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
test(
  "reporting.attachments-stay-file-backed",
  { tag: "@harness" },
  async ({ page }, info) => {
    await page.setContent("<main>File-backed evidence canary</main>");
    await expect(page.getByRole("main")).toHaveText(
      "File-backed evidence canary",
    );
    const body = Buffer.alloc(256 * 1024, 255);
    for (let i = 0; i < 128; i++) {
      await info.attach(`attachment-${i}`, {
        body,
        contentType: "application/octet-stream",
      });
    }
  },
);
