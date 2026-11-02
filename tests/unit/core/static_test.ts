// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { staticResponse } from "../../../core/http/static.ts";
import { tempDir, test } from "../../support/resources.ts";

test("static owner resolves regular files and SPA paths by type with mount-relative HTML", async () => {
  const root = await tempDir("static-types-");
  await Deno.mkdir(join(root, "assets"));
  await Deno.writeTextFile(join(root, "index.html"), "<head></head><p>SPA</p>");
  await Deno.writeTextFile(join(root, "assets/app.js"), "/* script */");
  await Deno.writeTextFile(
    join(root, "assets/page.html"),
    "<head></head><p>Page</p>",
  );
  for (
    const [path, base] of [
      ["/", "./"],
      ["/index.html", "./"],
      ["/assets", "./"],
      ["/assets/", "../"],
      ["/assets/missing.js", "../"],
      ["/nested/route", "../"],
      ["/nested/route/", "../../"],
      ["/assets%2F", "../"],
    ]
  ) {
    const response = await staticResponse(path, { staticRoot: root });
    assertEquals(response.status, 200, path);
    assertEquals(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
      path,
    );
    assertEquals(response.headers.get("cache-control"), "no-cache", path);
    assertEquals(
      response.headers.get("x-content-type-options"),
      "nosniff",
      path,
    );
    assertEquals(
      await response.text(),
      `<head><base href="${base}"></head><p>SPA</p>`,
      path,
    );
  }
  const asset = await staticResponse("/assets/app.js", { staticRoot: root });
  assertEquals(
    asset.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assertEquals(await asset.text(), "/* script */");
  const page = await staticResponse("/assets/page.html", { staticRoot: root });
  assertEquals(await page.text(), '<head><base href="../"></head><p>Page</p>');
  for (const path of ["/api", "/api/missing", "/%", "/%2E%2E/private"]) {
    const response = await staticResponse(path, { staticRoot: root });
    assertEquals(response.status, 404, path);
    await response.text();
  }
});

test("static owner uses bundled fallback when the configured index is absent or not a file", async () => {
  const root = await tempDir("static-index-");
  const bundled = await Deno.readTextFile(
    new URL("../../../core/static/index.html", import.meta.url),
  );
  for (const directoryIndex of [false, true]) {
    if (directoryIndex) await Deno.mkdir(join(root, "index.html"));
    for (const path of ["/", "/index.html", "/nested/route/"]) {
      const response = await staticResponse(path, { staticRoot: root });
      assertEquals(response.status, 200, path);
      assertEquals(
        response.headers.get("content-type"),
        "text/html; charset=utf-8",
        path,
      );
      assertEquals(await response.text(), bundled, path);
    }
  }
});
