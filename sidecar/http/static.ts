// SPDX-License-Identifier: LGPL-3.0-only
import { extname, fromFileUrl, join, normalize } from "@std/path";
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
  _app: unknown,
): Promise<Response> {
  if (path === "/api" || path.startsWith("/api/")) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }
  const root = fromFileUrl(new URL("../../web/dist/", import.meta.url));
  let relative: string;
  try {
    relative = decodeURIComponent(path.slice(1)) || "index.html";
  } catch {
    return new Response("Not found", { status: 404 });
  }
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
    if (
      !(e instanceof Deno.errors.NotFound) &&
      !(e instanceof Deno.errors.IsADirectory)
    ) throw e;
    try {
      return new Response(await Deno.readFile(join(root, "index.html")), {
        headers: {
          "content-type": types[".html"],
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return new Response(
        await Deno.readFile(new URL("../static/index.html", import.meta.url)),
        { headers: { "content-type": types[".html"] } },
      );
    }
  }
}
