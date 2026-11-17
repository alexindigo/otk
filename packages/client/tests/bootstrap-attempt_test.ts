// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ClientRequestPolicy } from "@otk/protocol";
import { type ConnectionOptions, SidecarConnection } from "../connection.ts";
import { createSidecars } from "../sidecars.ts";
import { HttpReadFailure } from "../http-requests.ts";
import {
  bootstrapFetch,
  fixtureRequestPolicy,
  fixtureRequests,
} from "../../../tests/support/request-wire.ts";
import { bounded } from "../../../tests/support/resources.ts";

const policy = { ...fixtureRequestPolicy, retrybase: 10, retrymax: 10 };
const auth = {
  authenticated: false,
  setupRequired: false,
  authType: "password",
  principal: "fixture",
  requests: fixtureRequests(),
};
const options = (input: ConnectionOptions & { policy: ClientRequestPolicy }) =>
  input;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("initial bootstrap retry uses supplied policy before any remote policy and stop retires it", async () => {
  let reads = 0;
  const retried = Promise.withResolvers<void>(), statuses: string[] = [];
  const bootstrap = bootstrapFetch(auth);
  const connection = new SidecarConnection(
    "http://remote.test",
    {
      status: (state) => statuses.push(state),
      frame() {},
    },
    options({
      policy,
      fetcher: (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/session")) {
          if (++reads === 1) {
            return Promise.reject(new TypeError("First contact unavailable"));
          }
          retried.resolve();
        }
        return bootstrap(input, init);
      },
    }),
  );
  try {
    await connection.connect();
    await bounded(
      "Initial failure must automatically retry",
      retried.promise,
      1000,
    );
    assertEquals(reads, 2);
    connection.stop();
    const before = reads;
    await pause(50);
    assertEquals(reads, before, "Stop cannot rearm the initial retry");
    assert(statuses.includes("reconnecting"));
  } finally {
    connection.stop();
  }
});

Deno.test("saved remotes inherit application bootstrap policy independently of the local API URL", async () => {
  const original = globalThis.fetch, retried = Promise.withResolvers<void>();
  let remoteReads = 0;
  const bootstrap = bootstrapFetch(auth);
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "remote.test" && url.pathname.endsWith("/session")) {
      if (++remoteReads === 1) {
        return Promise.reject(
          new TypeError("Remote first contact unavailable"),
        );
      }
      retried.resolve();
    }
    return bootstrap(input, init);
  };
  const collection = createSidecars(() => {}, {
    storage: {
      getItem: () =>
        JSON.stringify([{
          id: "remote",
          baseUrl: "http://remote.test",
          label: "Remote",
        }]),
      setItem() {},
    },
    connection: options({
      api: new URL("http://local.test/mounted/api/"),
      policy,
    }),
  });
  try {
    collection.start();
    await bounded(
      "Saved remote initial failure must retry",
      retried.promise,
      1000,
    );
    assertEquals(
      collection.connection("remote").base.href,
      "http://remote.test/api/",
    );
    assertEquals(
      collection.connection("local").base.href,
      "http://local.test/mounted/api/",
    );
    assertEquals(remoteReads, 2);
  } finally {
    collection.stop();
    globalThis.fetch = original;
  }
});

Deno.test("checked remote policy replaces the application's bootstrap retry values", async () => {
  const retried = Promise.withResolvers<void>();
  let reads = 0;
  const bootstrap = bootstrapFetch(auth);
  const connection = new SidecarConnection("http://remote.test", {
    status() {},
    frame() {},
  }, {
    policy: { ...policy, retrybase: 5000, retrymax: 5000 },
    fetcher: (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/session")) {
        if (++reads === 1) {
          return Promise.reject(new TypeError("After checked policy"));
        }
        retried.resolve();
      }
      return bootstrap(input, init);
    },
  });
  try {
    await connection.connect({
      ...auth,
      requests: { ...auth.requests, policy },
    });
    await connection.connect();
    await bounded(
      "Remote retry policy replaces bootstrap policy",
      retried.promise,
      1000,
    );
    assertEquals(reads, 2);
  } finally {
    connection.stop();
  }
});

Deno.test("accepted login followed by failed fresh session read preserves the attempt's connection failure", async () => {
  let state = "", message: string | undefined;
  const bootstrap = bootstrapFetch(auth);
  const connection = new SidecarConnection("http://remote.test", {
    status: (next, error) => {
      state = next;
      message = error;
    },
    frame() {},
  }, {
    fetcher: (input, init) =>
      new URL(String(input)).pathname.endsWith("/session")
        ? Promise.reject(new TypeError("Session check unavailable"))
        : bootstrap(input, init),
  });
  try {
    await connection.connect(auth);
    await assertRejects(
      () => connection.login({ username: "tester", password: "synthetic" }),
      HttpReadFailure,
    );
    assertEquals(state, "reconnecting");
    assert(
      message && !message.includes("cookie settings") &&
        !message.includes("accepted sign-in"),
    );
  } finally {
    connection.stop();
  }
});

Deno.test("connection attempt result distinguishes a fresh checked session from retained state", async () => {
  const connection = new SidecarConnection("http://remote.test", {
    status() {},
    frame() {},
  }, { fetcher: bootstrapFetch(auth) });
  try {
    const result = await connection.connect() as unknown as {
      kind?: string;
      auth?: typeof auth;
    } | undefined;
    assertEquals(result?.kind, "checked");
    assertEquals(result?.auth?.authenticated, false);
  } finally {
    connection.stop();
  }
});

Deno.test("superseded connection attempt cannot report an older successful session", async () => {
  const entered = Promise.withResolvers<void>();
  const bootstrap = bootstrapFetch(auth);
  const connection = new SidecarConnection("http://remote.test", {
    status() {},
    frame() {},
  }, {
    fetcher: (input, init) => {
      if (!new URL(String(input)).pathname.endsWith("/session")) {
        return bootstrap(input, init);
      }
      entered.resolve();
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        )
      );
    },
  });
  try {
    const old = connection.connect();
    await entered.promise;
    const next = await connection.connect(auth) as unknown as { kind: string };
    assertEquals(
      (await old as unknown as { kind: string })?.kind,
      "superseded",
    );
    assertEquals(next.kind, "checked");
  } finally {
    connection.stop();
  }
});

Deno.test("setup follow-up propagates its failed session attempt too", async () => {
  const bootstrap = bootstrapFetch(auth);
  const connection = new SidecarConnection("http://remote.test", {
    status() {},
    frame() {},
  }, {
    fetcher: (input, init) =>
      new URL(String(input)).pathname.endsWith("/session")
        ? Promise.reject(new TypeError("Setup session unavailable"))
        : bootstrap(input, init),
  });
  try {
    await assertRejects(
      () =>
        connection.setup({
          type: "password",
          username: "tester",
          password: "synthetic",
        }),
      HttpReadFailure,
    );
  } finally {
    connection.stop();
  }
});

Deno.test("retained addition draft edits are independent of a captured discovery and survive cancellation", async () => {
  const entered = Promise.withResolvers<void>();
  const collection = createSidecars(() => {}, {
    storage: { getItem: () => "[]", setItem() {} },
    discoveryFetch: (_input, options) =>
      new Promise((_resolve, reject) => {
        entered.resolve();
        options!.signal!.addEventListener("abort", () =>
          reject(options!.signal!.reason), { once: true });
      }),
  });
  const retained = collection as typeof collection & {
    editAdd?: (patch: { url?: string; label?: string }) => void;
    state: typeof collection.state & {
      addition?: { url: string; label: string };
    };
  };
  try {
    const work = collection.add("http://held.test", "Held");
    const rejection = assertRejects(() => work);
    await entered.promise;
    assert(
      retained.editAdd,
      "The retained owner, not a mounted Form, owns next-input draft",
    );
    retained.editAdd({
      url: "http://edited.test/path",
      label: "Keep my label",
    });
    assertEquals(collection.state.discovery?.target, "http://held.test");
    assertEquals(retained.state.addition, {
      url: "http://edited.test/path",
      label: "Keep my label",
    });
    await collection.cancelAdd!();
    await rejection;
    assertEquals(retained.state.addition, {
      url: "http://edited.test/path",
      label: "Keep my label",
    });
  } finally {
    await collection.cancelAdd?.();
    collection.stop();
  }
});
