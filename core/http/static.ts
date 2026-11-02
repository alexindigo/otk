// SPDX-License-Identifier: LGPL-3.0-only
import { extname, join, normalize } from "@std/path";
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
async function staticFile(
  path: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    // The compiled VFS and host filesystem use different directory-read errors.
    // Only regular files are readable assets, including the SPA index.
    if (!(await Deno.stat(path)).isFile) return null;
    return await Deno.readFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return null;
  }
}
export async function staticResponse(
  path: string,
  app: { staticRoot: string },
): Promise<Response> {
  if (path === "/api" || path.startsWith("/api/")) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }
  const root = app.staticRoot;
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
  const bytes = await staticFile(join(root, safe));
  if (bytes !== null) {
    if (extname(safe) === ".html") return html(bytes);
    return new Response(bytes, {
      headers: {
        "content-type": types[extname(safe)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const index = await staticFile(join(root, "index.html"));
  if (index !== null) return html(index);
  return new Response(
    await Deno.readFile(new URL("../static/index.html", import.meta.url)),
    { headers: { "content-type": types[".html"] } },
  );
}
