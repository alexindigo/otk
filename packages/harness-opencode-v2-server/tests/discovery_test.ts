// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { discoverV2, probeVersion } from "../discovery.ts";
import { Buffer } from "node:buffer";

Deno.test("version probe rejects HTML, recognizes V1/V2 and preserves 401", async () => {
  const reply = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  assertEquals(
    await probeVersion(
      "http://localhost",
      {},
      undefined,
      () => reply({ version: "2.2.6", pid: 42 }),
    ),
    { kind: "opencode-v2-server", version: "2.2.6", pid: 42 },
  );
  assertEquals(
    await probeVersion(
      "http://localhost",
      {},
      undefined,
      (url) =>
        String(url).endsWith("/api/info")
          ? Promise.resolve(new Response("<!doctype html>"))
          : reply({ healthy: true, version: "1.19.3" }),
    ),
    { kind: "opencode-v1", version: "1.19.3" },
  );
  await assertRejects(
    () =>
      probeVersion(
        "http://localhost",
        {},
        undefined,
        () => Promise.resolve(new Response("html")),
      ),
    Error,
    "neither",
  );
  await assertRejects(
    () => probeVersion("http://localhost", {}, undefined, () => reply({}, 401)),
    Error,
    "401",
  );
});

Deno.test("discovery uses UTF-8 Basic headers and distinguishes 401/stale registration", async () => {
  const root = await Deno.makeTempDir();
  const password = "p\u00e4ss-\u6771\u4eac";
  const expected = "Basic " +
    Buffer.from(`opencode:${password}`, "utf8").toString("base64");
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      if (
        request.headers.get("authorization") !== expected
      ) return new Response("Unauthorized", { status: 401 });
      return Response.json({ version: "2.2.6", pid: 42 });
    },
  );
  const file = root + "/service.json";
  const registration = {
    url: `http://127.0.0.1:${server.addr.port}`,
    version: "2.2.6",
    pid: 42,
    password,
  };
  try {
    await Deno.writeTextFile(file, JSON.stringify(registration));
    const discovered = await discoverV2(file);
    assertEquals(discovered.pid, 42);
    assertEquals(discovered.endpoint.auth?.password, password);
    await Deno.writeTextFile(
      file,
      JSON.stringify({ ...registration, password: "wrong" }),
    );
    await assertRejects(() => discoverV2(file), Error, "401");
    await Deno.writeTextFile(
      file,
      JSON.stringify({ ...registration, pid: 43 }),
    );
    await assertRejects(() => discoverV2(file), Error, "Stale");
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("missing service is plain and malformed registration is not missing", async () => {
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => discoverV2(root + "/service.json"),
      Error,
      "No opencode service is running",
    );
    await Deno.writeTextFile(root + "/service.json", "{");
    await assertRejects(
      () => discoverV2(root + "/service.json"),
      Error,
      "Malformed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("discovery rejects replacement identity even when endpoint credentials stay equal", async () => {
  const root = await Deno.makeTempDir();
  const file = root + "/service.json";
  let requests = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async () => {
      requests++;
      if (requests === 1) {
        await Deno.writeTextFile(
          file,
          JSON.stringify({ ...registration, id: "replacement", pid: 43 }),
        );
        return Response.json({ version: "2.2.6", pid: 42 });
      }
      return Response.json({ version: "2.2.6", pid: 43 });
    },
  );
  const registration: {
    id: string;
    url: string;
    version: string;
    pid: number;
  } = {
    id: "original",
    url: `http://127.0.0.1:${server.addr.port}`,
    version: "2.2.6",
    pid: 42,
  };
  try {
    await Deno.writeTextFile(file, JSON.stringify(registration));
    await assertRejects(
      () => discoverV2(file),
      Error,
      "changed during discovery",
    );
    assertEquals(requests, 2);
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
