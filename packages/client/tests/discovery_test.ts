// SPDX-License-Identifier: LGPL-3.0-only
// INV-H probe cases retargeted to the discovery owner: a held request waits for Cancel.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { PROTOCOL_VERSION } from "@otk/protocol";
import { createDiscovery } from "../discovery.ts";
import { actionFeedback } from "../failure-features.ts";
import { FeedbackFailure, RequestFailure } from "../failures.ts";
import { HttpRequests } from "../http-requests.ts";
import { createSidecars } from "../sidecars.ts";
import { SidecarConnection } from "../connection.ts";
import {
  bootstrapFetch,
  fixtureRequests,
} from "../../../tests/support/request-wire.ts";

const identity = {
  product: "otk",
  protocol: PROTOCOL_VERSION,
  version: "test",
  originAllowed: true,
  signIn: "none",
};
const auth = {
  authenticated: true,
  setupRequired: false,
  authType: "none",
  principal: "test",
  requests: fixtureRequests(),
};
const base = new URL("http://fixture.invalid/api/");
for (
  const scenario of [
    "network-rejection",
    "foreign-json",
    "foreign-html",
    "http-401",
    "origin",
    "protocol",
  ] as const
) {
  Deno.test(`discovery ends once and presents action/target/reason/recovery: ${scenario}`, async () => {
    let signIns = 0;
    const owner = createDiscovery({
      base,
      origin: "http://page.invalid",
      signIn: () => {
        signIns++;
        return Promise.resolve(auth);
      },
      fetcher: () => {
        if (scenario === "network-rejection") {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (scenario === "foreign-html") {
          return Promise.resolve(new Response("<html>not OTK</html>"));
        }
        if (scenario === "http-401") {
          return Promise.resolve(
            Response.json({ error: "Unauthorized" }, { status: 401 }),
          );
        }
        return Promise.resolve(Response.json(
          scenario === "foreign-json" ? { ok: true } : {
            ...identity,
            originAllowed: scenario !== "origin",
            protocol: scenario === "protocol" ? -1 : PROTOCOL_VERSION,
          },
        ));
      },
    });
    const result = await owner.start();
    assertEquals(result.kind, "failed");
    assertEquals(owner.state.pending, false);
    assertEquals(signIns, 0);
    assert(owner.state.steps.every((step) => step.result));
    if (result.kind !== "failed") throw new Error("Expected failure");
    const text = actionFeedback(new FeedbackFailure(result.feedback))!.text;
    assert(text.includes("fixture.invalid"));
    assert(!text.includes("Could not finish this action"));
    if (scenario === "origin") {
      assert(text.includes("http://page.invalid"));
      assert(text.includes("[server].origins"));
    }
    if (scenario === "http-401") assert(text.includes("HTTP 401"));
    assertEquals(owner.state.steps.at(-1)?.result?.kind, "error");
  });
}
Deno.test("held discovery has live elapsed time, no deadline, joined cancellation and fresh retry", async () => {
  let now = 0, tick = () => {}, active = 0, cleaned = false;
  const entered = Promise.withResolvers<void>();
  const owner = createDiscovery({
    base,
    signIn: () => Promise.resolve(auth),
    clock: {
      now: () => now,
      every(callback) {
        tick = callback;
        active++;
        return () => {
          active--;
        };
      },
    },
    fetcher: (_url, options) =>
      new Promise((_resolve, reject) => {
        entered.resolve();
        options!.signal!.addEventListener("abort", () => {
          cleaned = true;
          reject(options!.signal!.reason);
        }, { once: true });
      }),
  });
  const first = owner.start();
  assertEquals(owner.start(), first);
  await entered.promise;
  now = 24 * 60 * 60 * 1000;
  tick();
  assertEquals(owner.state.pending, true);
  assertEquals(owner.state.steps[0].elapsedMs, now);
  await owner.cancel();
  assert(cleaned);
  assertEquals((await first).kind, "cancelled");
  assertEquals(active, 0);
  assertEquals(owner.state.steps[0].result?.kind, "cancelled");
});
for (const kind of ["ready", "login-required", "setup-required"] as const) {
  Deno.test(`discovery signs in with exactly one result per step: ${kind}`, async () => {
    const owner = createDiscovery({
      base,
      fetcher: () => Promise.resolve(Response.json(identity)),
      signIn: () =>
        Promise.resolve({
          ...auth,
          authenticated: kind === "ready",
          setupRequired: kind === "setup-required",
        }),
    });
    assertEquals((await owner.start()).kind, kind);
    assertEquals(owner.state.steps.map((s) => s.key), [
      "connecting",
      "identity",
      "sign-in",
    ]);
    assert(owner.state.steps.every((s) => s.result));
  });
}
Deno.test("post-identity sign-in transport failure ends its step and releases the read", async () => {
  const http = new HttpRequests({
    base,
    kind: () => "read",
    fetcher: () => Promise.reject(new TypeError("refused")),
  });
  const owner = createDiscovery({
    base,
    fetcher: () => Promise.resolve(Response.json(identity)),
    signIn: (signal) => http.read("session", { signal }),
  });
  try {
    assertEquals((await owner.start()).kind, "failed");
    assertEquals(owner.state.steps.at(-1)?.key, "sign-in");
    assertEquals(owner.state.steps.at(-1)?.result?.kind, "error");
  } finally {
    await http.stop();
  }
});
Deno.test("finite HTTP reads reject malformed admission immediately; valid event transport remains compatible", async () => {
  for (
    const fetcher of [
      () => Promise.resolve(Response.json({ ok: true })),
      () => Promise.reject(new TypeError("refused")),
    ]
  ) {
    const http = new HttpRequests({ base, kind: () => "read", fetcher });
    try {
      await assertRejects(() => http.read("health"));
    } finally {
      await http.stop();
    }
  }
  const http = new HttpRequests({
    base,
    kind: () => "read",
    fetcher: bootstrapFetch(),
  });
  try {
    assertEquals((await http.read<typeof auth>("session")).authenticated, true);
  } finally {
    await http.stop();
  }
});

Deno.test("same-URL additions release failure and cancellation joins before the next explicit check", async () => {
  let mode: "failed" | "held" | "login" = "failed", calls = 0;
  let entered = Promise.withResolvers<void>();
  const bootstrap = bootstrapFetch({
    ...auth,
    authenticated: false,
    authType: "password",
  });
  const collection = createSidecars(() => {}, {
    storage: { getItem: () => "[]", setItem() {} },
    discoveryFetch: (input, options) => {
      if (!String(input).endsWith("discovery")) {
        return bootstrap(input, options);
      }
      calls++;
      entered.resolve();
      if (mode === "failed") return Promise.reject(new TypeError("refused"));
      if (mode === "login") return Promise.resolve(Response.json(identity));
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        )
      );
    },
  });
  try {
    const first = collection.add("http://remote.test/", "Remote");
    assertEquals(collection.add("http://remote.test", "Remote"), first);
    await assertRejects(() => first, FeedbackFailure);
    mode = "held";
    entered = Promise.withResolvers<void>();
    const held = collection.add("http://remote.test", "Remote");
    const rejection = assertRejects(() => held, FeedbackFailure, "cancelled");
    await entered.promise;
    await collection.cancelAdd!();
    await rejection;
    assertEquals(collection.state.discovery?.pending, false);
    mode = "login";
    const id = await collection.add("http://remote.test", "Remote");
    assertEquals(calls, 3);
    assertEquals(
      collection.state.list.find((s) => s.id === id)?.status,
      "login required",
    );
  } finally {
    collection.stop();
  }
});

Deno.test("discovery reserves before publication and cancellation before dispatch starts no transport", async () => {
  let calls = 0;
  const owner = createDiscovery({
    base,
    signIn: () => Promise.resolve(auth),
    fetcher: () => {
      calls++;
      return Promise.resolve(Response.json(identity));
    },
  });
  let reentrant: Promise<unknown> | undefined;
  const release = owner.subscribe((state) => {
    if (state.pending && !reentrant) reentrant = owner.start();
  });
  const first = owner.start();
  assertEquals(first, reentrant);
  await owner.cancel();
  assertEquals((await first).kind, "cancelled");
  assertEquals(calls, 0);
  release();
});

for (const phase of ["identity", "sign-in"] as const) {
  Deno.test(`cancelling held ${phase} joins cleanup and prevents late results`, async () => {
    const entered = Promise.withResolvers<void>();
    let cleaned = false;
    const held = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        entered.resolve();
        signal.addEventListener("abort", () =>
          queueMicrotask(() => {
            cleaned = true;
            reject(signal.reason);
          }), { once: true });
      });
    const owner = createDiscovery({
      base,
      fetcher: (_url, options) => {
        if (phase !== "identity") {
          return Promise.resolve(Response.json(identity));
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              async pull(controller) {
                try {
                  await held(options!.signal!);
                } catch (cause) {
                  controller.error(cause);
                }
              },
            }, { highWaterMark: 0 }),
          ),
        );
      },
      signIn: async (signal) => phase === "sign-in" ? await held(signal) : auth,
    });
    const work = owner.start();
    await entered.promise;
    await owner.cancel();
    assert(cleaned);
    assertEquals((await work).kind, "cancelled");
    assertEquals(owner.state.steps.at(-1)?.key, phase);
    assert(owner.state.steps.every((step) => step.result));
    assertEquals(owner.state.steps.at(-1)?.result?.kind, "cancelled");
  });
}

Deno.test("a transport timeout is reported, not invented from elapsed time", async () => {
  const owner = createDiscovery({
    base,
    fetcher: () =>
      Promise.reject(new DOMException("provider timeout", "TimeoutError")),
    signIn: () => Promise.resolve(auth),
  });
  const result = await owner.start();
  assertEquals(result.kind, "failed");
  assert(
    "feedback" in result &&
      result.feedback.text.includes("transport reported a timeout"),
  );
});

Deno.test("addition cancellation before dispatch cannot install a server", async () => {
  let calls = 0;
  const bootstrap = bootstrapFetch({ ...auth, authenticated: false });
  const collection = createSidecars(() => {}, {
    storage: { getItem: () => "[]", setItem() {} },
    discoveryFetch: (input, options) => {
      calls++;
      return String(input).endsWith("discovery")
        ? Promise.resolve(Response.json(identity))
        : bootstrap(input, options);
    },
  });
  try {
    const work = collection.add("http://remote.test", "Remote");
    const rejection = assertRejects(() => work, FeedbackFailure, "cancelled");
    await collection.cancelAdd!();
    await rejection;
    assertEquals(calls, 0);
    assertEquals(collection.state.list.length, 1);
  } finally {
    collection.stop();
  }
});

Deno.test("sign-in acceptance without an authenticated session retains actionable connection feedback across form remount", async () => {
  const required = { ...auth, authenticated: false, authType: "password" };
  let error: string | undefined;
  const connection = new SidecarConnection("http://remote.test", {
    status(_state, value) {
      error = value;
    },
    frame() {},
  }, { fetcher: bootstrapFetch(required) });
  try {
    await connection.connect(required);
    await assertRejects(
      () => connection.login({ username: "tester", password: "never-display" }),
      FeedbackFailure,
      "still not authenticated",
    );
    assert(error?.includes("remote.test"));
    assert(error?.includes("cookie settings"));
    assert(!error?.includes("never-display"));
  } finally {
    connection.stop();
  }
});

Deno.test("sign-in HTTP failures retain status without copying credential-bearing response bodies", async () => {
  const http = new HttpRequests({
    base,
    kind: () => "read",
    fetcher: () =>
      Promise.resolve(
        Response.json({ secret: "never-copy-this-body" }, { status: 403 }),
      ),
  });
  const owner = createDiscovery({
    base,
    fetcher: () => Promise.resolve(Response.json(identity)),
    signIn: (signal) => http.read("session", { signal }),
  });
  try {
    const result = await owner.start();
    assertEquals(result.kind, "failed");
    assert("feedback" in result && result.feedback.text.includes("HTTP 403"));
    assert(
      "feedback" in result &&
        !result.feedback.text.includes("never-copy-this-body"),
    );
  } finally {
    await http.stop();
  }
});

Deno.test("receipt reset ends a read-only sign-in check without changing mutation recovery", async () => {
  const bootstrap = bootstrapFetch();
  const http = new HttpRequests({
    base,
    kind: () => "read",
    fetcher: (input, options) => {
      if (!String(input).endsWith("request-events")) {
        return bootstrap(input, options);
      }
      const { ref } = JSON.parse(String(options?.body));
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
  const owner = createDiscovery({
    base,
    fetcher: () => Promise.resolve(Response.json(identity)),
    signIn: (signal) => http.read("session", { signal }),
  });
  try {
    const result = await owner.start();
    assertEquals(result.kind, "failed");
    assert(
      "feedback" in result &&
        result.feedback.text.includes("reset the sign-in check's receipt"),
    );
  } finally {
    await http.stop();
  }
});

Deno.test("an unregistered sign-in rejection keeps its supplied code and honestly marks the absent reason", async () => {
  const owner = createDiscovery({
    base,
    fetcher: () => Promise.resolve(Response.json(identity)),
    signIn: () =>
      Promise.reject(
        new RequestFailure({
          code: "fixture.new-rejection",
          retry: "none",
          diagnosticID: "opaque",
        }),
      ),
  });
  const result = await owner.start();
  assertEquals(result.kind, "failed");
  assert(
    "feedback" in result &&
      result.feedback.text.includes("fixture.new-rejection"),
  );
  assert(
    "feedback" in result &&
      result.feedback.text.includes("no further reason was supplied"),
  );
  assert(
    "feedback" in result && result.feedback.text.includes("fixture.invalid"),
  );
  assert(
    "feedback" in result &&
      !result.feedback.text.includes("Could not finish this action"),
  );
});
