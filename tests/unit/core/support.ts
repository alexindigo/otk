// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import { loadServiceConfig, type ServiceConfig } from "../../../core/mod.ts";
import { tempDir } from "../../support/resources.ts";

export const defaultsPath = fromFileUrl(
  new URL("../../fixtures/core/defaults.toml", import.meta.url),
);
export function cfg(): ServiceConfig {
  return loadServiceConfig({ defaultsPath, env: {} }).config;
}
export function fixture(): Promise<string> {
  return tempDir("core-unit-");
}
