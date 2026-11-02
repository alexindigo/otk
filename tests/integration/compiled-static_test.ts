// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { nativeFixture } from "../support/native-fixture.ts";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { test } from "../support/resources.ts";

test("compiled static paths preserve files, directory SPA fallback and API 404", async () => {
  await preparedBinary();
  const fixture = await nativeFixture();
  try {
    const server = await fixture.sidecar();
    const index = await fetch(server.url + "/");
    assertEquals(index.status, 200);
    const html = await index.text();
    const withoutBase = (text: string) =>
      text.replace(/<base href="[^"]*">/, "");
    for (
      const path of [
        "/assets/",
        "/assets",
        "/assets%2F",
        "/assets/missing.js",
        "/nested/route",
        "/nested/route/",
        "/index.html",
      ]
    ) {
      const response = await fetch(server.url + path);
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
      assertEquals(withoutBase(await response.text()), withoutBase(html), path);
    }
    const script = /src="([^"]+\.js)"/.exec(html);
    assert(script, html);
    const asset = await fetch(new URL(script[1], server.url + "/"));
    assertEquals(asset.status, 200);
    assertEquals(
      asset.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert((await asset.text()).length > 0);
    for (const path of ["/api", "/api/missing", "/%2E%2E%2Fprivate"]) {
      const response = await fetch(server.url + path);
      assertEquals(response.status, 404, path);
      await response.text();
    }
  } finally {
    await fixture.stop();
  }
});
