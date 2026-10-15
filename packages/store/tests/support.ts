// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
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
  const root = fromFileUrl(new URL("../../../.test-state/", import.meta.url));
  await Deno.mkdir(root, { recursive: true });
  return Deno.makeTempDir({ dir: root, prefix: "store-" });
}
