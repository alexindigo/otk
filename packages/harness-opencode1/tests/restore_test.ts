// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Opencode1Adapter } from "../adapter.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { join } from "@std/path";
test("restore resolves its directory and posts unrevert before returning authoritative session", async () => {
  const calls: unknown[] = [];
  const adapter = new Opencode1Adapter(
    {
      harness: {
        url: "http://fixture",
        username: "",
        password: "",
        db: join(await tempDir("restore-"), "missing.db"),
        heartbeattimeout: 25,
        reconnectmax: 30,
      },
      index: { days: 30 },
    },
    undefined,
    (input, init) => {
      const url = new URL(String(input));
      calls.push([
        url.pathname,
        init?.method ?? "GET",
        url.searchParams.get("directory"),
      ]);
      return Promise.resolve(Response.json(
        url.pathname.endsWith("/unrevert") ? true : {
          id: "s",
          title: "S",
          directory: "/project",
          projectID: "p",
          time: { created: 1, updated: 2 },
        },
      ));
    },
  );
  try {
    const restored = await adapter.capabilities.restore!.restore("s");
    assertEquals(restored.revert, undefined);
    assertEquals(calls, [["/session/s", "GET", null], [
      "/session/s/unrevert",
      "POST",
      "/project",
    ], ["/session/s", "GET", null]]);
  } finally {
    await adapter.core.stop();
  }
});
