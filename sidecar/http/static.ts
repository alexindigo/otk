// SPDX-License-Identifier: LGPL-3.0-only
import { extname, fromFileUrl, join, normalize } from "@std/path";
import type { App } from "@pathfinder/pathfinder";
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
export async function staticResponse(
  path: string,
  app: App,
): Promise<Response> {
  if (path === "/api" || path.startsWith("/api/")) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }
  const root = fromFileUrl(new URL("../static/", import.meta.url));
  const relative = path === "/"
    ? (app.auth.setupRequired ? "setup.html" : "index.html")
    : path === "/login"
    ? "login.html"
    : path === "/setup"
    ? "setup.html"
    : decodeURIComponent(path.slice(1));
  const safe = normalize(relative);
  if (safe.startsWith("../") || safe === ".." || safe.startsWith("/")) {
    return new Response("Not found", { status: 404 });
  }
  try {
    return new Response(await Deno.readFile(join(root, safe)), {
      headers: {
        "content-type": types[extname(safe)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return new Response("Not found", { status: 404 });
  }
}
