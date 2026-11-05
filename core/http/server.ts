// SPDX-License-Identifier: LGPL-3.0-only
import { pathfinder } from "@pathfinder/pathfinder";
import { fromFileUrl } from "@std/path";
import type { App } from "@pathfinder/pathfinder";
import type { ServiceConfig } from "../config/schema.ts";
import type { DiagnosticSink } from "@otk/protocol";
import "./app.ts";
/** Reserve the address before acquiring backend work. Until activated, no routes run. */
export function bind(
  cfg: ServiceConfig,
  signal?: AbortSignal,
  diagnostic?: DiagnosticSink,
) {
  let handler: Deno.ServeHandler<Deno.NetAddr> = () =>
    new Response("Starting", { status: 503 });
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve({
      hostname: cfg.server.host,
      port: cfg.server.port,
      signal,
      onListen() {},
    }, (request, info) => handler(request, info));
  } catch (error) {
    if (error instanceof Deno.errors.AddrInUse) {
      throw new Error(
        `Port ${cfg.server.port} is in use; configure OTK_SERVER_PORT`,
      );
    }
    throw error;
  }
  return {
    server,
    async handle(app: App) {
      const router = await pathfinder({
        roots: [fromFileUrl(new URL("./routes/", import.meta.url))],
        app,
      });
      handler = (request, info) => {
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
      };
      const hostname = server.addr.hostname.includes(":")
        ? `[${server.addr.hostname}]`
        : server.addr.hostname;
      diagnostic?.(
        "info",
        `Listening on http://${hostname}:${server.addr.port}/`,
      );
    },
  };
}
export async function serve(
  app: App,
  signal?: AbortSignal,
): Promise<Deno.HttpServer<Deno.NetAddr>> {
  const listener = bind(app.cfg, signal);
  try {
    await listener.handle(app);
    return listener.server;
  } catch (error) {
    await listener.server.shutdown();
    throw error;
  }
}
