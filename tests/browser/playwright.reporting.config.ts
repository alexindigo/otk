// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
export default defineConfig({
  ...base,
  testMatch: ["tooling/reporting.spec.ts"],
  testIgnore: [],
  projects: [{ name: "reporting" }],
  workers: 1,
  retries: 1,
});
