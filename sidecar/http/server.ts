// SPDX-License-Identifier: LGPL-3.0-only
import { pathfinder } from "@pathfinder/pathfinder";
import { fromFileUrl } from "@std/path";
import type { App } from "@pathfinder/pathfinder";
import "./app.ts";
export async function serve(
  app: App,
  signal?: AbortSignal,
): Promise<Deno.HttpServer> {
  const router = await pathfinder({
    roots: [fromFileUrl(new URL("./routes/", import.meta.url))],
    app,
  });
  try {
    return Deno.serve({
      hostname: app.cfg.server.host,
      port: app.cfg.server.port,
      signal,
    }, router);
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `Port ${app.cfg.server.port} is in use; configure OTK_SERVER_PORT`,
      );
    }
    throw error;
  }
}
