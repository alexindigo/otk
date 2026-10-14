// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError, type Middleware } from "@pathfinder/pathfinder";
import type { ServiceConfig } from "../config/schema.ts";
import type {} from "../http/app.ts";
export function allowedOrigin(req: Request, cfg: ServiceConfig): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin !== "null" &&
    (origin === new URL(req.url).origin || cfg.server.origins.includes(origin));
}
const publicPaths = new Set([
  "/api/health",
  "/api/setup",
  "/api/login",
  "/api/session",
]);
const middleware: Middleware = async (request, { app }) => {
  if (
    !allowedOrigin(request._raw, app.cfg) &&
    (request.method !== "GET" || request.path === "/api/ws")
  ) throw new HttpError(403, { code: "origin", message: "Origin not allowed" });
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin")!;
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
      },
    });
  }
  if (!publicPaths.has(request.path)) {
    if (app.auth.setupRequired) {
      throw new HttpError(503, { code: "setup_required" });
    }
    if (!await app.auth.authenticated(request._raw)) {
      throw new HttpError(401, { code: "unauthenticated" });
    }
  }
  const origin = request.headers.get("origin");
  return (response) => {
    if (origin && app.cfg.server.origins.includes(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Credentials", "true");
      response.headers.append("Vary", "Origin");
    }
  };
};
export default middleware;
