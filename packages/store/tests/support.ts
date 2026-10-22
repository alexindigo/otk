// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir } from "../../../tests/support/resources.ts";
import {
  type FeatureMigrations,
  frecencyMigrations,
  prefsMigrations,
  type PrefsOptions,
} from "@otk/store";

export const migrations: readonly FeatureMigrations[] = [
  prefsMigrations,
  frecencyMigrations,
];
export interface TestPrefs {
  thinking: "show" | "hide";
  timestamps: boolean;
}
export const defaults: Readonly<TestPrefs> = {
  thinking: "hide",
  timestamps: false,
};
export const prefsOptions: PrefsOptions<TestPrefs> = {
  defaults,
  validate: (key, value): key is keyof TestPrefs =>
    key === "thinking"
      ? value === "show" || value === "hide"
      : key === "timestamps" && typeof value === "boolean",
  invalid: () => new Error("Invalid preference key or value"),
};
export const frecencyOptions = {
  invalid: () => new Error("Invalid frecency path length or value"),
};

export async function fixture(): Promise<string> {
  return await tempDir("store-");
}
