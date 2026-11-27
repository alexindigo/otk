// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { nativeFixture } from "../support/native-fixture.ts";
import { test } from "../support/resources.ts";
import { HttpRequests } from "@otk/client";
import { WsClient } from "../support/ws-client.ts";
import { browserSessionID } from "../support/browser-native.ts";

test("inline image HTTP and RPC admit only authenticated, same-policy image reads", async (t) => {
  const f = await nativeFixture();
  const server = await f.sidecar({
    auth: {
      type: "password",
      username: "tester",
      password: "fixture-secret",
      secretkey: "01234567890123456789012345678901",
    },
  });
  const session = browserSessionID((await f.oc.createSession("Images")).id);
  const url = (path: string, id = session) =>
    new URL(
      `/api/inline-image?${new URLSearchParams({ session: id, path })}`,
      server.url,
    );
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jc1sAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  const outside = join(f.oc.root, "outside.png");
  await Deno.writeFile(outside, png);
  await Deno.writeFile(join(f.oc.directory, "picture"), png);
  await Deno.writeFile(join(f.oc.directory, ".hidden.png"), png);
  await Deno.writeTextFile(join(f.oc.directory, "notes.png"), "plain notes");
  await Deno.writeTextFile(
    join(f.oc.directory, "drawing.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><title>Drawing</title></svg>',
  );
  await Deno.writeTextFile(
    join(f.oc.directory, "invalid.svg"),
    "<!DOCTYPE svg><svg/>",
  );

  await t.step("auth protects the endpoint before file lookup", async () => {
    const response = await fetch(url("picture"));
    assertEquals(response.status, 401);
    assertEquals(await response.json(), { code: "unauthenticated" });
  });

  let cookie = "";
  const http = new HttpRequests({
    base: new URL("/api/", server.url),
    async fetcher(input, options) {
      const headers = new Headers(options?.headers);
      headers.set("Origin", server.url);
      const response = await fetch(input, { ...options, headers });
      const value = response.headers.get("set-cookie");
      if (value) cookie = value.split(";", 1)[0];
      return response;
    },
  });
  try {
    await http.start("login", {
      username: "tester",
      password: "fixture-secret",
    }).result;
    assert(cookie);
  } finally {
    await http.stop();
  }
  const get = (path: string, headers: HeadersInit = {}, id = session) => {
    const sending = new Headers(headers);
    sending.set("Cookie", cookie);
    return fetch(url(path, id), { headers: sending });
  };

  await t.step(
    "content type, sandbox, nosniff, CORP and conditional response",
    async () => {
      for (
        const [path, mime] of [["picture", "image/png"], [
          "drawing.svg",
          "image/svg+xml",
        ]]
      ) {
        const response = await get(path, { Origin: server.url });
        assertEquals(response.status, 200);
        assertEquals(response.headers.get("content-type"), mime);
        assertEquals(response.headers.get("x-content-type-options"), "nosniff");
        assertStringIncludes(
          response.headers.get("content-security-policy") ?? "",
          "sandbox",
        );
        assertEquals(
          response.headers.get("cross-origin-resource-policy"),
          "same-origin",
        );
        assertEquals(
          response.headers.get("cache-control"),
          "private, no-cache",
        );
        assertEquals(
          await response.bytes(),
          await Deno.readFile(join(f.oc.directory, path)),
        );
        const etag = response.headers.get("etag");
        assert(etag);
        const cached = await get(path, { "If-None-Match": etag });
        assertEquals(cached.status, 304);
        assertEquals(cached.headers.get("etag"), etag);
        assertEquals(await cached.text(), "");
      }
    },
  );

  await t.step(
    "origin and fetch-site checks reject forbidden origins",
    async () => {
      for (
        const headers of [
          new Headers({ Origin: "https://foreign.invalid" }),
          new Headers({ Origin: "null" }),
          new Headers({ "Sec-Fetch-Site": "cross-site" }),
        ]
      ) {
        const response = await get("picture", headers);
        assertEquals(response.status, 403);
        assertEquals(await response.json(), { code: "origin" });
      }
    },
  );

  const paths = [
    outside,
    "missing.png",
    "notes.png",
    ".hidden.png",
    "invalid.svg",
  ];
  const reasons = ["outside", "missing", "not-image", "denied", "not-image"];
  await t.step("refusals never expose host paths or HTML", async () => {
    for (const [i, path] of paths.entries()) {
      const response = await get(path);
      const reason = reasons[i];
      assertEquals(response.status, [403, 404, 415, 403, 415][i]);
      const body = await response.text();
      assert(!body.includes(f.oc.root));
      assert(!body.startsWith("<"));
      assertEquals(response.headers.get("x-content-type-options"), "nosniff");
      assertEquals(response.headers.get("cache-control"), "no-store");
      if (response.status === 404) {
        assertStringIncludes(
          response.headers.get("content-type") ?? "",
          "text/plain",
        );
        assertEquals(body, "Not found");
      } else assertEquals(JSON.parse(body), { code: `image-${reason}` });
    }
    const unknown = await get(
      "picture",
      {},
      session.slice(0, -1) + (session.endsWith("A") ? "B" : "A"),
    );
    assertEquals(unknown.status, 404);
    assertEquals(await unknown.text(), "Not found");
    const invalid = await fetch(
      server.url + "/api/inline-image?session=" + session,
      { headers: { Cookie: cookie } },
    );
    assertEquals(invalid.status, 400);
    assertEquals(await invalid.json(), { code: "params" });
  });

  await t.step("RPC agrees with HTTP on refusal reasons", async () => {
    const client = new WsClient(server.url, cookie);
    await client.connect(f.oc.directory, session);
    const facts = await client.rpc<{ status: string; reason: string }[]>(
      "file.images",
      { sessionID: session, paths },
    );
    assertEquals(
      facts.map((fact) => [fact.status, fact.reason]),
      reasons.map((reason) => ["unavailable", reason]),
    );
    await client.close();
  });
});
