// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { HttpError, type Middleware } from "@pathfinder/pathfinder";
import middleware from "../../../core/auth/middleware.ts";
import { cfg } from "./support.ts";
import { test } from "../../support/resources.ts";

function context(app: unknown): Parameters<Middleware>[1] {
  return { app } as Parameters<Middleware>[1];
}

function request(path: string, origin?: string, upgrade?: string | string[]) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  for (const token of typeof upgrade === "string" ? [upgrade] : upgrade ?? []) {
    headers.append("upgrade", token);
  }
  const raw = new Request(`http://otk.test${path}`, { headers });
  return { _raw: raw, path, method: "GET", headers } as Parameters<
    Middleware
  >[0];
}

test("every WebSocket upgrade checks Origin before authentication", async () => {
  let authCalls = 0;
  const app = {
    cfg: cfg(),
    auth: {
      setupRequired: false,
      authenticated: () => {
        authCalls++;
        return false;
      },
    },
  } as unknown as Parameters<Middleware>[1]["app"];
  for (const path of ["/api/ws", "/api/ws/", "/api/terminal", "/api/x"]) {
    for (const origin of ["http://foreign.test", undefined]) {
      const error = await assertRejects(
        async () =>
          await middleware(request(path, origin, "WebSocket"), context(app)),
        HttpError,
      );
      assertEquals(error.status, 403);
    }
  }
  assertEquals(authCalls, 0);
  for (const path of ["/api/ws", "/api/ws/", "/api/terminal", "/api/x"]) {
    const error = await assertRejects(
      async () =>
        await middleware(
          request(path, "http://otk.test", "websocket"),
          context(app),
        ),
      HttpError,
    );
    assertEquals(error.status, 401);
  }
  assertEquals(authCalls, 4);
  const error = await assertRejects(
    async () =>
      await middleware(request("/api/x", "http://foreign.test"), context(app)),
    HttpError,
  );
  assertEquals(error.status, 401);
  assertEquals(authCalls, 5);
});

test("discovery retains its separate public GET exception", async () => {
  const result = await middleware(
    request("/api/discovery", "http://foreign.test"),
    context({}),
  );
  assertEquals(typeof result, "function");
});

test("token-list and duplicate Upgrade headers enforce the same Origin boundary", async () => {
  let authCalls = 0;
  const app = {
    cfg: cfg(),
    auth: {
      setupRequired: false,
      authenticated: () => {
        authCalls++;
        return false;
      },
    },
  };
  for (const path of ["/api/ws", "/api/ws/", "/api/terminal", "/api/x"]) {
    for (
      const upgrade of ["h2c, WebSocket", " WebSocket , h2c ", [
        "h2c",
        "wEbSoCkEt",
      ]]
    ) {
      for (
        const origin of [undefined, "http://foreign.test", "http://otk.test"]
      ) {
        const before = authCalls;
        const error = await assertRejects(
          async () =>
            await middleware(request(path, origin, upgrade), context(app)),
          HttpError,
        );
        assertEquals(error.status, origin === "http://otk.test" ? 401 : 403);
        assertEquals(authCalls - before, origin === "http://otk.test" ? 1 : 0);
      }
    }
  }
  const error = await assertRejects(
    async () =>
      await middleware(
        request("/api/x", "http://foreign.test", "h2c, not-websocket"),
        context(app),
      ),
    HttpError,
  );
  assertEquals(error.status, 401);
});
