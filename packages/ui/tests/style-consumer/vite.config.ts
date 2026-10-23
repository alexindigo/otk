// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  root: new URL("./", import.meta.url).pathname,
  base: "./",
  resolve: {
    alias: {
      "@otk/client":
        new URL("../../../client/mod.ts", import.meta.url).pathname,
      "@otk/protocol":
        new URL("../../../protocol/mod.ts", import.meta.url).pathname,
    },
  },
  plugins: [solid({ compiler: "native", hot: false })],
});
