// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { nativeFixture } from "../support/native-fixture.ts";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { test } from "../support/resources.ts";

test("compiled HTTP routing answers malformed paths with 400 without server errors", async () => {
  await preparedBinary();
  const fixture = await nativeFixture();
  try {
    const server = await fixture.sidecar();
    const results = [];
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
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const response = await fetch(server.url + path, {
          method,
          signal: AbortSignal.timeout(5000),
        });
        results.push([method, path, response.status]);
        await response.text();
      }
    }
    const upgrade = await fetch(server.url + "/api/ws/%", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
      signal: AbortSignal.timeout(5000),
    });
    results.push(["upgrade", "/api/ws/%", upgrade.status]);
    await upgrade.text();
    assertEquals(
      results,
      results.map(([method, path]) => [method, path, 400]),
    );
    for (const path of ["/%25", "/caf%C3%A9", "/nested%2Froute"]) {
      const response = await fetch(server.url + path);
      assertEquals(response.status, 200, path);
      assert((await response.text()).includes("<head>"));
    }
    const health = await fetch(server.url + "/api/health?q=%E0%A4%A&other=%");
    assertEquals(health.status, 200);
    assertEquals((await health.json()).ok, true);
    assertEquals(server.process.exitCode, null);
    assert(
      !/URIError|URI malformed|Error handling request/.test(server.log),
      server.log,
    );
  } finally {
    await fixture.stop();
  }
});
