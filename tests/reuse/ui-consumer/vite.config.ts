// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  root: new URL("./", import.meta.url).pathname,
  base: "./",
  resolve: {
    alias: {
      "@otk/ui":
        new URL("../../../packages/ui/mod.ts", import.meta.url).pathname,
      "@otk/client":
        new URL("../../../packages/client/mod.ts", import.meta.url).pathname,
      "@otk/protocol":
        new URL("../../../packages/protocol/mod.ts", import.meta.url).pathname,
    },
  },
  plugins: [solid({ compiler: "native", hot: false })],
  worker: { format: "es" },
});
