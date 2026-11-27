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

test("unmatched asset requests never receive the SPA document", async () => {
  const root = await tempDir("static-miss-");
  await Deno.writeTextFile(join(root, "index.html"), "<head></head><p>SPA</p>");
  const app = { staticRoot: root };
  for (
    const [path, dest] of [
      ["/home/fixture/x/a.PNG", null],
      ["/assets/missing.js", "document"],
      ["/sessions/abc", "image"],
      ["/sessions/abc", "style"],
    ] as const
  ) {
    const response = await Reflect.apply(staticResponse, undefined, [
      path,
      app,
      { dest },
    ]) as Response;
    assertEquals(response.status, 404, path);
    assertEquals(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(await response.text(), "Not found");
  }
  const navigation = await Reflect.apply(staticResponse, undefined, [
    "/sessions/abc",
    app,
    { dest: "document" },
  ]) as Response;
  assertEquals(navigation.status, 200);
  assertEquals(
    navigation.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  await navigation.text();
  const api = await staticResponse("/api/x", app);
  assertEquals(api.status, 404);
  assertEquals(await api.json(), { code: "not_found" });
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
