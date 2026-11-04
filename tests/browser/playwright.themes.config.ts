// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
export default defineConfig({
  ...base,
  testMatch: ["themes/sweep.spec.ts"],
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  projects: [{ name: "themes", metadata: { nativeVersion: "1.18.34" } }],
  timeout: 240_000,
  use: { ...base.use, actionTimeout: 10_000 },
});
