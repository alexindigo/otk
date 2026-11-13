// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import { loadServiceConfig } from "./loader.ts";

// Shipped defaults only. Never project the resolved operator/auth configuration.
const shipped = loadServiceConfig({
  defaultsPath: fromFileUrl(
    new URL("../../defaults/otk.toml", import.meta.url),
  ),
  env: {},
}).config;
export const PUBLIC_DEFAULTS = Object.freeze({
  defaultPort: shipped.server.port,
});
