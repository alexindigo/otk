// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { parse } from "@std/toml";
import { PUBLIC_DEFAULTS } from "../../../core/config/public-defaults.ts";
import { test } from "../../support/resources.ts";
import { AuthState } from "../../../core/auth/state.ts";
import { serve } from "../../../core/http/server.ts";
import type { App } from "@pathfinder/pathfinder";
import { cfg } from "./support.ts";

test("public defaults expose only the shipped port, not operator values", async () => {
  const document = parse(
    await Deno.readTextFile(
      new URL("../../../defaults/otk.toml", import.meta.url),
    ),
  );
  assertEquals(PUBLIC_DEFAULTS, {
    defaultPort: (document.server as { port: number }).port,
  });
  const config = cfg();
  config.server.port = 0;
  config.auth.secretkey = "private-signing-key";
  const auth = new AuthState(config);
  const server = await serve({ cfg: config, auth } as App);
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.addr.port}/api/session`,
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).defaults, PUBLIC_DEFAULTS);
  } finally {
    await server.shutdown();
  }
});
