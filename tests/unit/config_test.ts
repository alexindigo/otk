// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ConfigError, loadServiceConfig } from "../../sidecar/config/loader.ts";
import { cfg, defaultsPath, fixture } from "../support/config.ts";

Deno.test("config collects unknown, missing and wrong-type diagnostics with env names", async () => {
  const root = await fixture(), file = join(root, "bad.toml");
  await Deno.writeTextFile(file, '[server]\nport = "bad"\nextra = 1\n');
  const error = assertThrows(
    () => loadServiceConfig({ defaultsPath: file, env: {} }),
    ConfigError,
  );
  assert(
    error.problems.some((p) =>
      p.includes("OTK_SERVER_PORT") && p.includes("expected int")
    ),
  );
  assert(
    error.problems.some((p) =>
      p.includes("OTK_SERVER_EXTRA") && p.includes("unknown")
    ),
  );
  assert(
    error.problems.some((p) =>
      p.includes("OTK_SERVER_HOST") && p.includes("missing")
    ),
  );
});
Deno.test("config defaults -> state -> overlay -> env preserves explicit empty list", async () => {
  const root = await fixture(), overlayPath = join(root, "overlay.toml");
  await Deno.writeTextFile(
    overlayPath,
    '[server]\nport=9000\norigins=["https://extra"]\n[auth]\nusername="overlay"\n',
  );
  const result = loadServiceConfig({
    defaultsPath,
    overlayPath,
    authState: { username: "state", type: "password" },
    env: {
      OTK_SERVER_PORT: "9010",
      OTK_SERVER_ORIGINS: "",
      OTK_AUTH_USERNAME: "env",
    },
  });
  assertEquals(result.config.server.port, 9010);
  assertEquals(result.config.server.origins, []);
  assertEquals(result.config.auth.username, "env");
  assertEquals(result.config.auth.type, "password");
});
Deno.test("config rejects unknown env, section variables and fractional integers", () => {
  const error = assertThrows(
    () =>
      loadServiceConfig({
        defaultsPath,
        env: { OTK_SERVER: "x", OTK_SERVER_PORT: "1.2", OTK_UNKNOWN: "x" },
      }),
    ConfigError,
  );
  assertEquals(error.problems.length, 3);
});
Deno.test("config explicit inputs leave process env untouched and retain shipped defaults", () => {
  const before = Deno.env.toObject();
  const overridden =
    loadServiceConfig({ defaultsPath, env: { OTK_SERVER_PORT: "7777" } })
      .config;
  assertEquals(overridden.server.port, 7777);
  assertEquals(overridden.harness.heartbeattimeout, 25);
  assertEquals(cfg().server.port, 1502);
  assertEquals(Deno.env.toObject(), before);
});
Deno.test("config rejects inherited property names as unknown schema nodes", () => {
  const error = assertThrows(
    () =>
      loadServiceConfig({
        defaultsPath,
        env: {},
        authState: { constructor: {} },
      }),
    ConfigError,
  );
  assert(
    error.problems.some((problem) =>
      problem.includes("OTK_AUTH_CONSTRUCTOR") &&
      problem.includes("unknown node")
    ),
  );
});
