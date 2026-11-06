// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createIndex,
  createSession,
  RequestFailure,
  SidecarConnection,
} from "@otk/client";
import type { Preferences, PromptInput } from "@otk/protocol";
import { CapabilityRegistry, requireCapability } from "@otk/harness";
import { coreBackendFixture } from "../support/core-backend.ts";
import { fixture } from "../support/config.ts";
import { waitFor } from "../support/opencode.ts";
import { originFetch } from "../support/request-wire.ts";

declare module "@otk/protocol" {
  interface CapabilityContracts {
    "feature.measure": { read(): Promise<number> };
  }
}

test("a feature-owned capability reaches registry, wire advertisement and client availability without a central name edit", async () => {
  const registry = new CapabilityRegistry();
  registry.register("feature.measure", { read: () => Promise.resolve(42) });
  assertEquals(registry.names(), ["feature.measure"]);
  assertEquals(
    await requireCapability(registry.capabilities, "feature.measure").read(),
    42,
  );
  const app = await coreBackendFixture(await fixture(), registry.capabilities);
  const client = await consumer(app.url);
  try {
    assert(client.connection.supports("feature.measure"));
    assertEquals(client.connection.supports("prompt"), false);
  } finally {
    await client.stop();
    await app.app.stop();
  }
});

async function consumer(url: string) {
  const index = createIndex();
  const session = createSession(
    () => connection,
    (id, sessionID) => index.state.entries[`${id}/${sessionID}`],
  );
  let connected = false;
  let prefs: Preferences | undefined;
  let socket: WebSocket | undefined;
  const connection = new SidecarConnection(url, {
    status: (state) => connected = state === "connected",
    frame(frame) {
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        assert(index.receive("app", frame));
      }
      if (frame.t === "prefs") prefs = frame.prefs;
      session.receive("app", frame);
    },
  }, {
    fetcher: originFetch(url),
    socket: (address) =>
      socket = Reflect.construct(WebSocket, [address, {
        headers: { Origin: url },
      }]) as WebSocket,
  });
  try {
    connection.view({ selected: "tstv1-core", crumbs: [], rows: [] });
    await connection.connect();
    await waitFor(() => connected && !!prefs, Boolean);
  } catch (error) {
    connection.stop();
    throw error;
  }
  return {
    connection,
    index,
    session,
    prefs: () => prefs,
    async stop() {
      session.stop();
      const closed = !socket || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
          socket!.addEventListener("close", () => resolve(), { once: true })
        );
      connection.stop();
      await closed;
    },
  };
}

test("application composition with an external core-only backend reaches client state and retains store contributions across restart", async () => {
  const root = await fixture();
  let app = await coreBackendFixture(root);
  let client = await consumer(app.url);
  try {
    assertEquals(client.connection.supports("prompt"), false);
    assertEquals(
      client.index.state.entries["app/tstv1-core"].title,
      "Core-only backend",
    );
    client.session.open({ sidecarId: "app", sessionID: "tstv1-core" });
    await waitFor(() => !client.session.state.loading, Boolean);
    assertEquals(client.session.state.error, undefined);
    assert(
      JSON.stringify(client.session.state.content.messages).includes(
        "Core transcript",
      ),
    );
    await client.connection.rpc.call("prefs.set", {
      key: "timestamps",
      value: true,
    });
    await waitFor(() => client.prefs()?.timestamps === true, Boolean);
    await client.connection.rpc.call("frecency.bump", {
      sessionID: "tstv1-core",
      path: "src/example.ts",
    });
    const rejected = await assertRejects(
      () =>
        client.connection.rpc.call("session.prompt", {
          sessionID: "tstv1-core",
          parts: [],
          mode: "normal",
        }),
      RequestFailure,
    );
    assertEquals(rejected.failure.code, "request.method");
    await client.stop();
    await app.app.stop();
    app = await coreBackendFixture(root);
    client = await consumer(app.url);
    assertEquals(client.prefs()?.timestamps, true);
    assertEquals(
      (await client.connection.rpc.call("prefs.get", {}))
        .timestamps,
      true,
    );
    const entries = await client.connection.rpc.call(
      "frecency.list",
      { sessionID: "tstv1-core" },
    );
    assertEquals(entries.entries.length, 1);
    assertEquals(entries.entries[0].path, join(root, "src/example.ts"));
  } finally {
    await client.stop();
    await app.app.stop();
  }
});

test("application composition registers only supplied optional capabilities and forwards public RPC inputs to that backend", async () => {
  const root = await fixture();
  const prompts: PromptInput[] = [];
  const searches: [string, string][] = [];
  const app = await coreBackendFixture(root, {
    prompt: {
      prompt(input) {
        prompts.push(input);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    },
    files: {
      findFiles(id, query) {
        searches.push([id, query]);
        return Promise.resolve([{ path: "src/example.ts", directory: false }]);
      },
    },
  });
  const client = await consumer(app.url);
  try {
    assert(client.connection.supports("prompt"));
    assert(client.connection.supports("files"));
    assertEquals(client.connection.supports("shell"), false);
    const input: PromptInput = {
      sessionID: "tstv1-core",
      mode: "normal",
      parts: [{ kind: "text", text: "Caller prompt" }],
    };
    await client.connection.rpc.call("session.prompt", input);
    assertEquals(JSON.parse(JSON.stringify(prompts)), [input]);
    assertEquals(
      await client.connection.rpc.call("find.files", {
        sessionID: "tstv1-core",
        query: "example",
      }),
      [{ path: "src/example.ts", directory: false }],
    );
    assertEquals(searches, [["tstv1-core", "example"]]);
    const rejected = await assertRejects(
      () =>
        client.connection.rpc.call("session.shell", {
          sessionID: "tstv1-core",
          command: "unused",
        }),
      RequestFailure,
    );
    assertEquals(rejected.failure.code, "request.method");
  } finally {
    await client.stop();
    await app.app.stop();
  }
});
