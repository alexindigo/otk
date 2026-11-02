// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { App } from "@pathfinder/pathfinder";
import { serve } from "../../../core/http/server.ts";
import { tempDir, test } from "../../support/resources.ts";

test("HTTP routing rejects malformed pathname encoding before dispatch for every method", async () => {
  const root = await tempDir("http-paths-");
  await Deno.writeTextFile(`${root}/index.html`, "<head></head><p>SPA</p>");
  const server = await serve({
    cfg: { server: { host: "127.0.0.1", port: 0 } },
    staticRoot: root,
  } as unknown as App);
  const url = `http://127.0.0.1:${server.addr.port}`;
  try {
    const results = [];
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) {
      for (
        const path of [
          "/%",
          "/%E0%A4%A",
          "/%GG",
          "/%FF",
          "/%C0%AF",
          "/%ED%A0%80",
          "/nested/%/route",
          "/api/session%",
          "/api/ws/%",
        ]
      ) {
        const response = await fetch(url + path, {
          method,
          signal: AbortSignal.timeout(5000),
        });
        results.push([method, path, response.status]);
        await response.text();
      }
    }
    assertEquals(
      results,
      results.map(([method, path]) => [method, path, 400]),
    );
  } finally {
    await server.shutdown();
  }
});

test("HTTP routing preserves valid encoded paths and forgiving query parsing", async () => {
  const root = await tempDir("http-valid-paths-");
  await Deno.writeTextFile(`${root}/index.html`, "<head></head><p>SPA</p>");
  await Deno.writeTextFile(`${root}/%.txt`, "literal percent");
  await Deno.writeTextFile(`${root}/%25.txt`, "encoded percent");
  await Deno.writeTextFile(`${root}/café.txt`, "unicode");
  const server = await serve({
    cfg: { server: { host: "127.0.0.1", port: 0 } },
    staticRoot: root,
  } as unknown as App);
  const url = `http://127.0.0.1:${server.addr.port}`;
  try {
    for (
      const [path, body] of [
        ["/%25.txt", "literal percent"],
        ["/%2525.txt", "encoded percent"],
        ["/caf%C3%A9.txt", "unicode"],
        ["/%25.txt?q=%E0%A4%A&other=%", "literal percent"],
      ]
    ) {
      const response = await fetch(url + path, {
        signal: AbortSignal.timeout(5000),
      });
      assertEquals(response.status, 200, path);
      assertEquals(await response.text(), body, path);
    }
    const missing = await fetch(url + "/api/missing");
    assertEquals(missing.status, 404);
    await missing.text();
  } finally {
    await server.shutdown();
  }
});
