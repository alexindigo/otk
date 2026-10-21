// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "vite";
import config from "../../../web/vite.config.ts";
export default defineConfig({
  ...config,
  root: new URL("./", import.meta.url).pathname,
});
