// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { prompt } from "../../pages/composer.ts";

test.use({ profile: "contract-composer-resource-attachments" });
for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`composer.attachment-read-failure-retains-file-identity-${theme}`, {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await state.product("prefs.set", { key: "theme", value: theme });
    // Fail only the browser's file-read boundary. The production upload, chip
    // owner and presenter remain untouched, rather than injecting styled state.
    await page.addInitScript(() => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        return this.name === "unreadable-style5.txt"
          ? Promise.reject(new Error("Fixture file read refused"))
          : read.call(this);
      };
    });
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await prompt(page).fill("Keep this draft after the file read fails");
    await page.locator('input[type="file"][aria-label="Attachments"]')
      .setInputFiles([
        {
          name: "unreadable-style5.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("unreadable"),
        },
        {
          name: "readable-style5.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("readable"),
        },
      ]);
    const attachments = page.locator(".otk-prompt-attachments");
    await expect(attachments.locator(".otk-failure-target")).toHaveText(
      "unreadable-style5.txt",
    );
    await expect(attachments.locator(".otk-prompt-chip.has-error")).toHaveCount(
      1,
    );
    await expect(attachments.locator(".otk-prompt-chip:not(.has-error)"))
      .toHaveCount(1);
    await expect(attachments.locator(".otk-failure-heading")).toHaveCount(1);
    await expect(prompt(page)).toHaveValue(
      /Keep this draft after the file read fails/,
    );
  });
}
