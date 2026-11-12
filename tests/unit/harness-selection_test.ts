// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { selectHarness } from "../../harness-selection.ts";
import { cfg } from "../support/config.ts";

Deno.test("auto falls back only for an absent registration; bad registrations never probe V1", async () => {
  const root = await Deno.makeTempDir();
  let probes = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      probes++;
      return new URL(request.url).pathname === "/global/health"
        ? Response.json({ healthy: true, version: "1.19.3" })
        : new Response("<html>V1 SPA</html>");
    },
  );
  const config = {
    ...cfg().harness,
    type: "auto",
    url: `http://127.0.0.1:${server.addr.port}`,
  };
  const env = { HOME: root, XDG_STATE_HOME: root };
  try {
    assertEquals(await selectHarness(config, env), {
      kind: "opencode-v1",
      version: "1.19.3",
    });
    probes = 0;
    await Deno.mkdir(root + "/opencode");
    await Deno.writeTextFile(root + "/opencode/service.json", "malformed");
    await assertRejects(() => selectHarness(config, env), Error, "Malformed");
    assertEquals(probes, 0);
    await assertRejects(
      () => selectHarness({ ...config, type: "wrong" }, env),
      Error,
      "unsupported backend",
    );
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit V1 rejects a V2 URL and explicit V2 reports no managed service", async () => {
  const root = await Deno.makeTempDir();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => Response.json({ version: "2.2.6", pid: 42 }),
  );
  const config = {
    ...cfg().harness,
    type: "opencode-v1",
    url: `http://127.0.0.1:${server.addr.port}`,
  };
  try {
    await assertRejects(
      () => selectHarness(config, { HOME: root }),
      Error,
      "Detected opencode V2",
    );
    await assertRejects(
      () =>
        selectHarness({ ...config, type: "opencode-v2-server" }, {
          HOME: root,
        }),
      Error,
      "No opencode service is running",
    );
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit V1 retains its offline lifetime for unknown health but not bad credentials", async () => {
  const root = await Deno.makeTempDir();
  let unauthorized = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response("unknown health", { status: unauthorized ? 401 : 503 }),
  );
  const config = {
    ...cfg().harness,
    type: "opencode-v1",
    url: `http://127.0.0.1:${server.addr.port}`,
  };
  try {
    assertEquals(await selectHarness(config, { HOME: root }), {
      kind: "opencode-v1",
      version: "unknown",
    });
    unauthorized = true;
    await assertRejects(
      () => selectHarness(config, { HOME: root }),
      Error,
      "401",
    );
    await server.shutdown();
    assertEquals(await selectHarness(config, { HOME: root }), {
      kind: "opencode-v1",
      version: "unknown",
    });
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("auto fallback failures name the missing registration, URL and actual credential source", async () => {
  const root = await Deno.makeTempDir();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response("Unauthorized", { status: 401 }),
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  const config = { ...cfg().harness, type: "auto", url, password: "" };
  const env = { HOME: root, XDG_STATE_HOME: root };
  try {
    for (const password of ["", "secret-config-password"]) {
      const error = await assertRejects(
        () => selectHarness({ ...config, password }, env),
        Error,
        "401",
      );
      assertStringIncludes(
        error.message,
        `no opencode service registration at ${root}/opencode/service.json`,
      );
      assertStringIncludes(error.message, url);
      assertStringIncludes(
        error.message,
        password
          ? "credentials from config/env"
          : "no credentials were sent (harness.url fallback)",
      );
      assertEquals(error.message.includes("secret-config-password"), false);
    }
    await server.shutdown();
    const error = await assertRejects(() => selectHarness(config, env), Error);
    assertStringIncludes(
      error.message,
      `no opencode service registration at ${root}/opencode/service.json`,
    );
    assertStringIncludes(error.message, url);
    assertStringIncludes(error.message, "unreachable");
    assertStringIncludes(
      error.message,
      "no credentials were sent (harness.url fallback)",
    );
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
