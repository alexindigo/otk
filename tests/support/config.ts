// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import { loadServiceConfig } from "../../core/mod.ts";

export const defaultsPath = fromFileUrl(
  new URL("../../defaults/otk.toml", import.meta.url),
);
export async function fixture(): Promise<string> {
  const root = fromFileUrl(new URL("../../.test-state/", import.meta.url));
  await Deno.mkdir(root, { recursive: true });
  return Deno.makeTempDir({ dir: root, prefix: "unit-" });
}
export function cfg() {
  return loadServiceConfig({ defaultsPath, env: {} }).config;
}
