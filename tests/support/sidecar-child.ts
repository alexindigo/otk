// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import { loadServiceConfig } from "../../sidecar/config/loader.ts";
import { start } from "../../sidecar/main.ts";
if (import.meta.main) {
  const config = loadServiceConfig({
    defaultsPath: fromFileUrl(
      new URL("../../defaults/otk.toml", import.meta.url),
    ),
    env: Deno.env.toObject(),
  }).config;
  const app = await start(config);
  const stop = async () => {
    await app.stop();
    Deno.exit();
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
}
