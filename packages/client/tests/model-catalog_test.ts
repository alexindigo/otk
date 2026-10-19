// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  createComposerSelection,
  createDrafts,
  createModelCatalog,
} from "@otk/client";
import { DEFAULT_PREFS, type ModelCatalog } from "@otk/protocol";

Deno.test("shared model catalog coalesces consumers, follows connection identity and retains last good data on failure", async () => {
  let connection = { key: "first", connected: true, available: true };
  const requests: {
    signal: AbortSignal;
    result: ReturnType<typeof Promise.withResolvers<ModelCatalog>>;
  }[] = [];
  const owner = createModelCatalog({
    connection: () => connection,
    load: (signal) => {
      const result = Promise.withResolvers<ModelCatalog>();
      requests.push({ signal, result });
      return result.promise;
    },
  });
  const catalog = { providers: [] };
  let joined = false;
  const release = owner.subscribe((state) => {
    if (state.loading && !joined) {
      joined = true;
      void owner.refresh();
    }
  });
  try {
    owner.connect();
    const meter = owner.ready(),
      composer = owner.ready(),
      opening = owner.refresh();
    await Promise.resolve();
    assertEquals(requests.length, 1);
    connection = { ...connection, key: "second" };
    owner.connect();
    const next = owner.ready();
    await Promise.resolve();
    assertEquals(requests.length, 2);
    assertEquals(requests[0].signal.aborted, true);
    requests[1].result.resolve(catalog);
    await Promise.all([meter, composer, next]);
    assertStrictEquals(owner.state.value, catalog);
    requests[0].result.resolve({
      providers: [],
      default: { provider: "old", model: "old" },
    });
    await opening;
    assertStrictEquals(owner.state.value, catalog);
    const failed = owner.refresh();
    await Promise.resolve();
    requests[2].result.reject(new Error("catalog offline"));
    await failed;
    assertEquals(owner.state.error, "catalog offline");
    assertStrictEquals(owner.state.value, catalog);
    await owner.ready();
    assertEquals(
      requests.length,
      3,
      "Reading readiness cannot retry a known failure",
    );
    connection = { ...connection, available: false };
    owner.connect();
    await owner.refresh();
    assertEquals(requests.length, 3);
    assertEquals(owner.state.available, false);
  } finally {
    release();
    owner.dispose();
  }
});

Deno.test("disposing one composer does not dispose its borrowed session catalog", async () => {
  const pending = Promise.withResolvers<ModelCatalog>();
  const catalog = createModelCatalog({
    connection: () => ({ key: "socket", connected: true, available: true }),
    load: () => pending.promise,
  });
  const draft = createDrafts(),
    composer = createComposerSelection({
      connection: () => ({
        key: "socket",
        connected: true,
        models: true,
        agents: false,
      }),
      modelCatalog: catalog,
      draft: () => draft.get("session"),
      change: draft.writer("session"),
      context: () => undefined,
      load: {
        agents: () => Promise.resolve([]),
        models: () => {
          throw new Error("Shared consumer must not load independently");
        },
      },
      prefs: { get: () => DEFAULT_PREFS, set: () => Promise.resolve() },
    });
  catalog.connect();
  composer.connect();
  assertStrictEquals(composer.state.models, catalog.state);
  composer.dispose();
  pending.resolve({ providers: [] });
  await catalog.ready();
  assertEquals(catalog.state.value, { providers: [] });
  catalog.dispose();
});
