// SPDX-License-Identifier: LGPL-3.0-only
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

const require = createRequire(
  new URL("../browser/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");

const [url, release] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.goto(url);
  const full = page.locator(".otk-toast").filter({
    hasText:
      "Storage is full: OTK can't save changes. Free disk space; OTK resumes automatically.",
  });
  await expect(full).toHaveCount(1, { timeout: 25000 });
  await expect(full).toBeVisible();
  console.log(
    "Browser observed exactly one visible actionable storage failure",
  );
  await writeFile(release, "observed\n");
  await expect(full).toHaveCount(0, { timeout: 25000 });
  await expect(
    page.locator(".otk-toast").filter({
      hasText: "Observation was interrupted",
    }),
  ).toBeVisible({ timeout: 5000 });
  console.log(
    "Browser observed automatic recovery and the explicit observation-gap notice",
  );
} finally {
  await browser.close();
}
