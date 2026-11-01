// SPDX-License-Identifier: LGPL-3.0-only
import { chromium, defineConfig } from "@playwright/test";
import { join } from "node:path";

const root = process.env.OTK_TEST_RUN_ROOT ??
  join(process.cwd(), "test-results", "unowned");
export default defineConfig({
  testDir: ".",
  testMatch: process.env.OTK_TEST_FORCED
    ? ["harness/failures/forced.spec.ts"]
    : [
      "behavior/**/*.spec.ts",
      "contracts/**/*.spec.ts",
      "harness/**/*.spec.ts",
    ],
  testIgnore: process.env.OTK_TEST_FORCED ? [] : ["harness/failures/**"],
  outputDir: join(root, "browser"),
  fullyParallel: true,
  workers: 3,
  forbidOnly: true,
  retries: 0,
  failOnFlakyTests: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: join(root, "results.json") }]],
  metadata: {
    node: process.version,
    deno: process.env.OTK_TEST_DENO_VERSION,
    tree: process.env.OTK_TEST_TREE,
    native: process.env.OTK_TEST_OPENCODE,
    nativeSha256: process.env.OTK_TEST_NATIVE_SHA256,
    browserExecutable: chromium.executablePath(),
    browser: "managed Chromium 156.0.8078.4 / revision 1248",
    run: process.env.OTK_TEST_RUN,
  },
  projects: ["1.18.34", "1.18.35", "1.19.3"].map((version) => ({
    name: `oc-${version}`,
  })),
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
