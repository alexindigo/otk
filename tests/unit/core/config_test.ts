// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ConfigError, loadServiceConfig } from "../../../core/mod.ts";
import { cfg, defaultsPath, fixture } from "./support.ts";

test("config collects unknown, missing and wrong-type diagnostics with env names", async () => {
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
test("config defaults -> state -> overlay -> env preserves explicit empty list", async () => {
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
test("config rejects unknown env, section variables and fractional integers", () => {
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
test("config explicit inputs leave process env untouched and retain shipped defaults", () => {
  const before = Deno.env.toObject();
  const overridden =
    loadServiceConfig({ defaultsPath, env: { OTK_SERVER_PORT: "7777" } })
      .config;
  assertEquals(overridden.server.port, 7777);
  assertEquals(overridden.harness.heartbeattimeout, 25);
  assertEquals(cfg().server.port, 1502);
  assertEquals(Deno.env.toObject(), before);
});
test("config rejects inherited property names as unknown schema nodes", () => {
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

test("config selects explicit file before XDG before legacy, then applies env leaves", async () => {
  const root = await fixture();
  const xdg = join(root, "settings");
  await Deno.mkdir(join(xdg, "otk"), { recursive: true });
  const user = join(xdg, "otk/otk.toml");
  const legacy = join(root, "legacy.toml");
  const explicit = join(root, "explicit.toml");
  await Deno.writeTextFile(user, "[server]\nport=9001\n");
  await Deno.writeTextFile(legacy, "[server]\nport=9002\n");
  await Deno.writeTextFile(explicit, "[server]\nport=9003\n");
  const sources = {
    defaultsPath,
    overlayPath: legacy,
    env: { HOME: root, XDG_CONFIG_HOME: xdg },
  };
  assertEquals(loadServiceConfig(sources).config.server.port, 9001);
  assertEquals(loadServiceConfig(sources).loaded, [defaultsPath, user]);
  assertEquals(
    loadServiceConfig({
      ...sources,
      env: { ...sources.env, OTK_CONFIG: explicit },
    }).config.server.port,
    9003,
  );
  assertEquals(
    loadServiceConfig({
      ...sources,
      env: { ...sources.env, OTK_CONFIG: explicit, OTK_SERVER_PORT: "9004" },
    }).config.server.port,
    9004,
  );
  await Deno.remove(user);
  assertEquals(loadServiceConfig(sources).config.server.port, 9002);
});

test("config uses HOME config when XDG is unset or empty, with optional absence", async () => {
  const home = await fixture();
  await Deno.mkdir(join(home, ".config/otk"), { recursive: true });
  const user = join(home, ".config/otk/otk.toml");
  await Deno.writeTextFile(user, "[server]\nport=9100\n");
  const environments: Record<string, string>[] = [{ HOME: home }, {
    HOME: home,
    XDG_CONFIG_HOME: "",
  }];
  for (const env of environments) {
    assertEquals(
      loadServiceConfig({ defaultsPath, env }).config.server.port,
      9100,
    );
  }
  await Deno.remove(user);
  assertEquals(
    loadServiceConfig({ defaultsPath, env: { HOME: home } }).config.server.port,
    1502,
  );
});

test("config never falls back from a broken user file or a missing explicit file", async () => {
  const home = await fixture();
  await Deno.mkdir(join(home, ".config/otk"), { recursive: true });
  await Deno.writeTextFile(
    join(home, ".config/otk/otk.toml"),
    '[server]\nport="bad"\n',
  );
  assertThrows(
    () => loadServiceConfig({ defaultsPath, env: { HOME: home } }),
    ConfigError,
  );
  assertThrows(() =>
    loadServiceConfig({
      defaultsPath,
      env: { HOME: home, OTK_CONFIG: join(home, "missing.toml") },
    }), ConfigError);
});
