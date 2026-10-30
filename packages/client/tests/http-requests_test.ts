// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { HttpRequests } from "../mod.ts";
import type { RequestRef } from "@otk/protocol";

Deno.test("HTTP consumer keeps one intent/receipt and settles only from its event stream", async () => {
  const requests: { url: string; body: unknown; secret: string | null }[] = [];
  const held = Promise.withResolvers<void>();
  const fetcher: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push({
      url: String(url),
      body,
      secret: new Headers(options?.headers).get("X-OTK-Receipt"),
    });
    const ref = body.ref as RequestRef;
    if (String(url).endsWith("request-events")) {
      await held.promise;
      return new Response(
        JSON.stringify({
          t: "request.accepted",
          ref,
          seq: 1,
          acceptedAt: 1,
          retentionUntil: 100,
          replayed: true,
        }) + "\n" +
          JSON.stringify({
            t: "request.result",
            ref,
            seq: 2,
            outcome: { ok: true, result: { ok: true } },
          }) + "\n",
      );
    }
    return Response.json({
      t: "request.accepted",
      ref,
      seq: 1,
      acceptedAt: 1,
      retentionUntil: 100,
      replayed: false,
    }, { status: 202 });
  };
  const http = new HttpRequests({
    base: new URL("https://example/api/"),
    fetcher,
    policy: { httpms: 1, retrybase: 1, retrymax: 2 },
  });
  try {
    const operation = http.start<{ ok: boolean }>("login", {
      username: "u",
      password: "never-persist",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(operation.state.phase, "queued");
    assertEquals(requests.length, 2);
    assertEquals(requests[0].secret?.length, 64);
    assertEquals(requests[0].secret, requests[1].secret);
    held.resolve();
    assertEquals(await operation.result, { ok: true });
  } finally {
    held.resolve();
    await http.stop();
  }
});

Deno.test("lost HTTP admission reattaches by receipt without resending credential input", async () => {
  let admissions = 0;
  const http = new HttpRequests({
    base: new URL("https://example/api/"),
    policy: { httpms: 20, retrybase: 1, retrymax: 2 },
    fetcher: (url, options) => {
      const body = JSON.parse(String(options?.body)), ref = body.ref;
      if (!String(url).endsWith("request-events")) {
        admissions++;
        return Promise.reject(new TypeError("connection lost after admission"));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            t: "request.accepted",
            ref,
            seq: 2,
            acceptedAt: 1,
            retentionUntil: 100,
            replayed: true,
          }) + "\n" +
            JSON.stringify({
              t: "request.result",
              ref,
              seq: 2,
              outcome: { ok: true, result: { ok: true } },
            }) + "\n",
        ),
      );
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = http.start<{ ok: true }>("login", {
      password: "captured",
    });
    assertEquals(
      await Promise.race([
        operation.result,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Lost admission was not reattached")),
            200,
          );
        }),
      ]),
      { ok: true },
    );
    assertEquals(admissions, 1);
  } finally {
    clearTimeout(timer);
    await http.stop();
  }
});

Deno.test("a reset bootstrap receipt remains input-required rather than failed or automatically submitted again", async () => {
  let admissions = 0;
  const http = new HttpRequests({
    base: new URL("https://example/api/"),
    policy: { httpms: 20, retrybase: 1, retrymax: 2 },
    fetcher: (url, options) => {
      const body = JSON.parse(String(options?.body)), ref = body.ref;
      if (!String(url).endsWith("request-events")) {
        admissions++;
        return Promise.resolve(
          Response.json({
            t: "request.accepted",
            ref,
            seq: 1,
            acceptedAt: 1,
            retentionUntil: 100,
            replayed: false,
          }, { status: 202 }),
        );
      }
      return Promise.resolve(
        Response.json({
          t: "request.rejected",
          ref,
          error: {
            code: "request.receipt-reset",
            retry: "none",
            diagnosticID: "opaque",
          },
        }, { status: 403 }),
      );
    },
  });
  try {
    const operation = http.start("login", { password: "captured" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(operation.state.phase, "waiting");
    assertEquals(operation.state.progress?.code, "input-required");
    assertEquals(admissions, 1);
  } finally {
    await http.stop();
  }
});
