// SPDX-License-Identifier: LGPL-3.0-only
import { pathfinder } from "@pathfinder/pathfinder";
import { fromFileUrl } from "@std/path";
import type { App } from "@pathfinder/pathfinder";
import "./app.ts";
export async function serve(
  app: App,
  signal?: AbortSignal,
): Promise<Deno.HttpServer<Deno.NetAddr>> {
  const router = await pathfinder({
    roots: [fromFileUrl(new URL("./routes/", import.meta.url))],
    app,
  });
  try {
    return Deno.serve({
      hostname: app.cfg.server.host,
      port: app.cfg.server.port,
      signal,
    }, (request, info) => {
      // Pathfinder decodes captures before its middleware/error boundary.
      // Validate once before any route or upgrade; retain the encoded URL so
      // routing and static serving still decode their own values exactly once.
      try {
        decodeURIComponent(new URL(request.url).pathname);
      } catch (error) {
        if (!(error instanceof URIError)) throw error;
        return new Response("Bad request", {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        });
      }
      return router(request, info);
    });
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `Port ${app.cfg.server.port} is in use; configure OTK_SERVER_PORT`,
      );
    }
    throw error;
  }
}
