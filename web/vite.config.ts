// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

// Native Oxc backend, characterized by the real-browser counter spike.
// https://github.com/solidjs/solid-vite-plugin/tree/next#optionscompiler
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [solid({ compiler: "native", hot: false })],
  worker: { format: "es" },
  build: { outDir: "dist" },
});
