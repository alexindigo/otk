// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { App } from "@pathfinder/pathfinder";
import { PROTOCOL_VERSION, SIDECAR_VERSION } from "@otk/protocol";
import { AuthState } from "../../../core/auth/state.ts";
import { serve } from "../../../core/http/server.ts";
import { test } from "../../support/resources.ts";
import { cfg } from "./support.ts";

function settings(type = "password") {
  const config = cfg();
  config.server.port = 0;
  config.server.origins = ["https://allowed.example"];
  Object.assign(config.auth, {
    type,
    username: "tester",
    password: "private-password",
    secretkey: "01234567890123456789012345678901",
    totpkey: "private-totp-key",
  });
  return config;
}

test("public discovery reports exact fields and existing origin policy without auth", async () => {
  const config = settings();
  const auth = new AuthState(config);
  auth.authenticated = () => {
    throw new Error("Discovery must not inspect credentials");
  };
  const server = await serve({ cfg: config, auth } as App);
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    for (
      const [origin, originAllowed] of [
        [base, true],
        ["https://allowed.example", true],
        ["https://denied.example", false],
        ["null", false],
        [undefined, false],
      ] as const
    ) {
      const response = await fetch(base + "/api/discovery", {
        headers: origin ? { Origin: origin } : {},
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
      assertEquals(
        response.headers.get("Access-Control-Allow-Credentials"),
        null,
      );
      assertEquals(response.headers.get("Set-Cookie"), null);
      assertEquals(response.headers.get("Cache-Control"), "no-store");
      assertEquals(await response.json(), {
        product: "otk",
        protocol: PROTOCOL_VERSION,
        version: SIDECAR_VERSION,
        originAllowed,
        signIn: "login",
      });
    }
  } finally {
    await server.shutdown();
  }
});

test("discovery sign-in describes server requirements and never honours credentials", async () => {
  for (
    const [type, signIn] of [["", "setup"], ["none", "none"], [
      "password",
      "login",
    ], ["totp", "login"]]
  ) {
    const config = settings(type);
    const auth = new AuthState(config);
    const token = type === "password"
      ? await auth.local!.login("tester", "private-password")
      : "ignored";
    const server = await serve({ cfg: config, auth } as App);
    const base = `http://127.0.0.1:${server.addr.port}`;
    try {
      for (
        const credentials of [{}, {
          Cookie: `${auth.cookieName}=${token}`,
          Authorization: `Bearer ${token}`,
        }]
      ) {
        const response = await fetch(base + "/api/discovery", {
          headers: {
            Origin: "https://denied.example",
            ...credentials as Record<string, string>,
          },
        });
        assertEquals(response.status, 200);
        assertEquals(
          response.headers.get("Access-Control-Allow-Credentials"),
          null,
        );
        assertEquals(response.headers.get("Set-Cookie"), null);
        assertEquals(await response.json(), {
          product: "otk",
          protocol: PROTOCOL_VERSION,
          version: SIDECAR_VERSION,
          originAllowed: false,
          signIn,
        });
      }
    } finally {
      await server.shutdown();
    }
  }
});

test("discovery alone permits non-credentialed preflight; other API policy is unchanged", async () => {
  const config = settings();
  const auth = new AuthState(config);
  const token = await auth.local!.login("tester", "private-password");
  const server = await serve({ cfg: config, auth } as App);
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    for (
      const origin of [
        "https://allowed.example",
        "https://denied.example",
        "null",
      ]
    ) {
      const response = await fetch(base + "/api/discovery", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      });
      assertEquals(response.status, 204);
      assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
      assertEquals(
        response.headers.get("Access-Control-Allow-Credentials"),
        null,
      );
      assertEquals(
        response.headers.get("Access-Control-Allow-Methods"),
        "GET, OPTIONS",
      );
      assertEquals(response.headers.get("Access-Control-Allow-Headers"), null);
      await response.text();
    }
    const denied = await fetch(base + "/api/session", {
      method: "OPTIONS",
      headers: {
        Origin: "https://denied.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    assertEquals(denied.status, 403);
    assertEquals(denied.headers.get("Access-Control-Allow-Origin"), null);
    await denied.text();
    const allowed = await fetch(base + "/api/session", {
      method: "OPTIONS",
      headers: {
        Origin: "https://allowed.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    assertEquals(allowed.status, 204);
    assertEquals(
      allowed.headers.get("Access-Control-Allow-Origin"),
      "https://allowed.example",
    );
    assertEquals(
      allowed.headers.get("Access-Control-Allow-Credentials"),
      "true",
    );
    await allowed.text();
    for (
      const [cookie, authenticated] of [["", false], [
        `${auth.cookieName}=${token}`,
        true,
      ]] as const
    ) {
      const response = await fetch(base + "/api/session", {
        headers: { Origin: "https://allowed.example", Cookie: cookie },
      });
      assertEquals(
        response.headers.get("Access-Control-Allow-Origin"),
        "https://allowed.example",
      );
      assertEquals(
        response.headers.get("Access-Control-Allow-Credentials"),
        "true",
      );
      assertEquals((await response.json()).authenticated, authenticated);
    }
    const protectedRoute = await fetch(base + "/api/logout", {
      method: "POST",
      headers: { Origin: "https://allowed.example" },
    });
    assertEquals(protectedRoute.status, 401);
    await protectedRoute.text();
    const post = await fetch(base + "/api/discovery", {
      method: "POST",
      headers: { Origin: "https://denied.example" },
    });
    assertEquals(post.status, 403);
    await post.text();
  } finally {
    await server.shutdown();
  }
});
