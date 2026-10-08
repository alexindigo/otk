// SPDX-License-Identifier: LGPL-3.0-only
import { extname, fromFileUrl, join, normalize } from "@std/path";
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
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
  const html = (bytes: Uint8Array): Response => {
    // Relative assets are rooted at the sidecar's mount, not at a fallback
    // route's depth. Relative ascent also retains a stripped proxy prefix.
    const depth = safe.split("/").filter(Boolean).length -
      (safe.endsWith("/") ? 0 : 1);
    const base = depth > 0 ? "../".repeat(depth) : "./";
    const text = new TextDecoder().decode(bytes).replace(
      "<head>",
      `<head><base href="${base}">`,
    );
    return new Response(text, {
      headers: {
        "content-type": types[".html"],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  };
  try {
    const bytes = await Deno.readFile(join(root, safe));
    if (extname(safe) === ".html") return html(bytes);
    return new Response(bytes, {
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
      return html(await Deno.readFile(join(root, "index.html")));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return new Response(
        await Deno.readFile(new URL("../static/index.html", import.meta.url)),
        { headers: { "content-type": types[".html"] } },
      );
    }
  }
}
