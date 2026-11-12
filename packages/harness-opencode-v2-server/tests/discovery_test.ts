// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { discoverV2, probeVersion } from "../discovery.ts";
import { Buffer } from "node:buffer";

for (
  const host of [
    "0.0.0.0",
    "127.0.0.1",
    "192.0.2.10",
    "opencode.home",
    "localhost",
    "[::]",
    "[::1]",
  ]
) {
  Deno.test(`discovery uses registration host ${host} verbatim`, async () => {
    const root = await Deno.makeTempDir();
    const requests: string[] = [];
    const registered = `http://${host}:4097`;
    const fetcher = globalThis.fetch;
    // Observe both OTK's diagnostic probe and the SDK's identity probe without
    // requiring a real LAN address, DNS entry or IPv6 wildcard route.
    globalThis.fetch = (input, init) => {
      requests.push(input instanceof Request ? input.url : String(input));
      assertEquals(
        new Headers(init?.headers).get("authorization"),
        "Basic " + Buffer.from("opencode:private-password").toString("base64"),
      );
      return Promise.resolve(Response.json({ version: "2.2.6", pid: 42 }));
    };
    try {
      const file = root + "/service.json";
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          url: registered,
          version: "2.2.6",
          pid: 42,
          password: "private-password",
        }),
      );
      const service = await discoverV2(file);
      assertEquals(service.endpoint.url, registered);
      assertEquals(service.endpoint.auth?.password, "private-password");
      assertEquals(requests, [
        registered + "/api/info",
        registered + "/api/info",
      ]);
    } finally {
      globalThis.fetch = fetcher;
      await Deno.remove(root, { recursive: true });
    }
  });
}

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
      { url: "http://localhost", source: { kind: "none" } },
      {},
      undefined,
      () => reply({ version: "2.2.6", pid: 42 }),
    ),
    { kind: "opencode-v2-server", version: "2.2.6", pid: 42 },
  );
  assertEquals(
    await probeVersion(
      { url: "http://localhost", source: { kind: "none" } },
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
        { url: "http://localhost", source: { kind: "none" } },
        {},
        undefined,
        () => Promise.resolve(new Response("html")),
      ),
    Error,
    "neither",
  );
  await assertRejects(
    () =>
      probeVersion(
        { url: "http://localhost", source: { kind: "none" } },
        {},
        undefined,
        () => reply({}, 401),
      ),
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

Deno.test("registration identity mismatch takes precedence over a 401 response", async () => {
  const root = await Deno.makeTempDir();
  const file = root + "/service.json";
  let info = { version: "2.2.6", pid: 42 };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => Response.json(info, { status: 401 }),
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  try {
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        url,
        pid: 42,
        version: "2.2.6",
        password: "wrong-password",
      }),
    );
    for (
      const mismatch of [{ version: "2.2.6", pid: 43 }, {
        version: "2.2.7",
        pid: 42,
      }]
    ) {
      info = mismatch;
      const error = await assertRejects(() => discoverV2(file), Error, "Stale");
      assertStringIncludes(error.message, url);
      assertStringIncludes(error.message, `registration ${file}`);
      assertEquals(error.message.includes("wrong-password"), false);
    }
    info = { version: "2.2.6", pid: 42 };
    const error = await assertRejects(() => discoverV2(file), Error, "401");
    assertStringIncludes(error.message, url);
    assertStringIncludes(error.message, `registration ${file}`);
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("all probe failures carry URL and provenance without exposing credentials", async () => {
  const url = "http://localhost:4097";
  const replies: Array<typeof fetch> = [
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.resolve(new Response("not JSON", { status: 503 })),
    () =>
      Promise.resolve(
        new Response("{", { headers: { "content-type": "application/json" } }),
      ),
    () => Promise.resolve(Response.json({ version: "3.0.0", pid: 42 })),
    (input) =>
      Promise.resolve(
        String(input).endsWith("/api/info")
          ? new Response("<html>")
          : new Response("Unauthorized", { status: 401 }),
      ),
  ];
  for (const fetcher of replies) {
    const error = await assertRejects(() =>
      probeVersion(
        { url, source: { kind: "config" } },
        { authorization: "Basic secret-password" },
        undefined,
        fetcher,
      ), Error);
    assertStringIncludes(error.message, url);
    assertStringIncludes(error.message, "credentials from config/env");
    assertEquals(error.message.includes("secret-password"), false);
  }
  const abort = new AbortController();
  const cause = new Error("caller cancelled");
  abort.abort(cause);
  assertEquals(
    await assertRejects(() =>
      probeVersion(
        { url, source: { kind: "none" } },
        {},
        abort.signal,
        () => Promise.reject(cause),
      )
    ),
    cause,
  );
});

Deno.test("probe diagnostics exclude credentials embedded in a configured URL", async () => {
  const error = await assertRejects(() =>
    probeVersion(
      {
        url:
          "http://private-user:private-password@localhost:4097/unused?auth_token=private-token#private-fragment",
        source: { kind: "config" },
      },
      {},
      undefined,
      () => Promise.reject(new TypeError("fetch failed")),
    ), Error);
  assertStringIncludes(error.message, "http://localhost:4097");
  assertStringIncludes(error.message, "credentials from config/env");
  for (
    const secret of [
      "private-user",
      "private-password",
      "private-token",
      "private-fragment",
    ]
  ) {
    assertEquals(error.message.includes(secret), false);
  }
});
