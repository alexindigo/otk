// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "@playwright/test";
import ordinary from "./playwright.config.ts";
import { projectPolicy } from "./project-policy.ts";
export default defineConfig({
  ...ordinary,
  testMatch: ["scale/**/*.spec.ts"],
  testIgnore: [],
  workers: 1,
  projects: ["1.18.34", "1.18.35", "1.19.3"].map((version) => ({
    name: `scale-${version}`,
    ...projectPolicy(`scale-${version}`),
  })),
  use: {
    ...ordinary.use,
    launchOptions: {
      args: ["--js-flags=--heap-snapshot-string-limit=4294967295"],
    },
  },
});
