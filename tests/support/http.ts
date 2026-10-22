// SPDX-License-Identifier: LGPL-3.0-only
import { resources } from "./resources.ts";

/** Register the listening socket before returning the HTTP fixture to its caller. */
export function serve(
  options: Deno.ServeTcpOptions & Deno.ServeOptions<Deno.NetAddr>,
  handler: Deno.ServeHandler<Deno.NetAddr>,
): Deno.HttpServer<Deno.NetAddr> {
  const scope = resources();
  const server = Deno.serve(options, handler);
  const shutdown = server.shutdown.bind(server);
  server.shutdown = scope.defer("HTTP fixture", shutdown);
  return server;
}
