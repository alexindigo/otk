// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tooling",
  testMatch: "*.spec.ts",
  outputDir: "./test-results/tooling",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  failOnFlakyTests: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/tooling.json" }]],
  metadata: {
    node: process.version,
    purpose: "pinned browser tooling acceptance",
  },
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
