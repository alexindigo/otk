// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  DirectoryCatalogs,
  type ProviderReadKinds,
  type ProviderReadOptions,
  type ProviderReadPort,
} from "@otk/harness";
import { createDirectoryCatalogs, modelGroups } from "@otk/client";
import { createCatalogCodecs, type DirectoryCatalog } from "@otk/protocol";
import {
  CatalogExecutor,
  mapModels,
  type V2Client,
} from "@otk/harness-opencode-v2-server";

Deno.test("catalog demand: native provider names stay independent of default selection", () => {
  const catalog = mapModels(
    [{
      id: "gpt-5.5",
      modelID: "gpt-5.5",
      providerID: "opencode",
      name: "GPT-5.5",
      variants: [],
      status: "active",
      enabled: true,
      cost: [],
      limit: { context: 200000, output: 10000 },
      time: { released: 1000 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      settings: {},
      headers: {},
    }],
    [{
      id: "opencode",
      name: "Default / OpenCode",
      activation: "auto",
      package: "fixture",
    }],
    undefined,
    [],
  );
  assertEquals(catalog.defaultState, "unknown");
  assertEquals(modelGroups(catalog, [], [])[0].label, "Default / OpenCode");
});

Deno.test("catalog demand: subscription is passive, warm-up is non-idle background and consumer promotes one lifetime", async () => {
  const calls: { kind: string; options: ProviderReadOptions }[] = [];
  const started = Promise.withResolvers<void>();
  let joined = false;
  const reads: ProviderReadPort = {
    async read<K extends keyof ProviderReadKinds>(
      kind: K,
      _input: ProviderReadKinds[K]["input"],
      options: ProviderReadOptions,
    ): Promise<ProviderReadKinds[K]["result"]> {
      calls.push({ kind, options });
      if (calls.length === 1) {
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener("abort", () => {
            // Native cancellation cleanup completes before the promoted exchange.
            joined = true;
            resolve();
          }, { once: true })
        );
        options.signal!.throwIfAborted();
      }
      assertEquals(joined, true);
      return {
        providers: [],
        defaultState: "unknown",
      } as ProviderReadKinds[K]["result"];
    },
    release() {},
  };
  const owner = new DirectoryCatalogs(reads, { pending: 100 });
  const lease = owner.acquire("/fixture");
  try {
    assertEquals(calls.length, 0);
    const warm = lease.get("models", undefined, "warm");
    void warm.catch(() => {}); // Preserve the assertion if final cleanup cancels the held read.
    await started.promise;
    assertEquals(calls[0].options.priority, "background");
    assertEquals(calls[0].options.optional, undefined);
    const consumer = lease.get("models");
    assertEquals(await warm, await consumer);
    assertEquals(calls.map((call) => call.options.priority), [
      "background",
      "user",
    ]);
    await lease.get("models");
    assertEquals(calls.length, 2);
  } finally {
    lease.release();
    await owner.stop();
  }
});

Deno.test("catalog demand: kind refresh and invalidation do not bootstrap unused catalogs", async () => {
  const calls: string[] = [];
  const owner = new DirectoryCatalogs({
    read<K extends keyof ProviderReadKinds>(
      kind: K,
    ): Promise<ProviderReadKinds[K]["result"]> {
      calls.push(kind);
      return Promise.resolve([] as unknown as ProviderReadKinds[K]["result"]);
    },
    release() {},
  }, { pending: 100 });
  const lease = owner.acquire("/fixture");
  try {
    owner.invalidate("/fixture");
    assertEquals(calls, []);
    await lease.get("agents", undefined, "warm");
    await lease.get("commands", undefined, "warm");
    await lease.refresh(undefined, ["agents"]);
    assertEquals(calls, [
      "catalog.agents",
      "catalog.commands",
      "catalog.agents",
    ]);
    owner.reset();
    await lease.get("agents", undefined, "warm");
    await lease.get("commands", undefined, "warm");
    assertEquals(calls.slice(3).sort(), ["catalog.agents", "catalog.commands"]);
  } finally {
    lease.release();
    await owner.stop();
  }
});

Deno.test("catalog demand: client warm breadth, lazy files, reconnect and release use the same resource", async () => {
  let watches = 0;
  const calls: {
    kinds: readonly string[];
    intent: string;
    signal?: AbortSignal;
  }[] = [];
  const initial = (): DirectoryCatalog => ({
    directory: "/p",
    generation: `g${watches}`,
    revision: 0,
    paths: { style: "posix", separator: "/" },
    values: Object.fromEntries(
      ["models", "agents", "commands", "skills", "files", "resources"].map((
        kind,
      ) => [kind, { state: "digesting", revision: 0 }]),
    ),
  });
  const owner = createDirectoryCatalogs({
    codecs: createCatalogCodecs(),
    watch() {
      watches++;
      return { result: Promise.resolve(initial()), release() {} };
    },
    demand: (_directory, kinds, intent, signal) => {
      calls.push({ kinds, intent, signal });
      return Promise.resolve();
    },
    refresh: () => Promise.resolve(),
  });
  const a = owner.acquire("/p"), b = owner.acquire("/p");
  await a.ready();
  assertEquals(calls, []);
  await a.warm(["models", "agents", "commands", "skills"]);
  assertEquals(calls.map(({ kinds, intent }) => ({ kinds, intent })), [{
    kinds: ["models", "agents", "commands", "skills"],
    intent: "warm",
  }]);
  const files = b.ready("files");
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(calls.at(-1)?.kinds, ["files"]);
  assertEquals(calls.at(-1)?.intent, "consumer");
  owner.receive({
    t: "catalog.chunk",
    directory: "/p",
    generation: "g1",
    revision: 1,
    transfer: "f",
    part: 0,
    last: true,
    kind: "files",
    items: [{ path: "one", canonicalPath: "/p/one", directory: false }],
  });
  await files;
  assertEquals(b.state.catalog?.values.files?.value?.length, 1);
  assertEquals(watches, 1);
  a.release();
  owner.receive({ t: "welcome" } as never);
  await b.ready();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(watches, 2);
  assertEquals(calls.some((call) => call.kinds.includes("resources")), false);
  b.release();
  assertEquals(calls.every((call) => call.signal?.aborted), true);
  owner.stop();
});

Deno.test("catalog demand: final release rejects a pending native kind and cannot publish late", async () => {
  const started = Promise.withResolvers<void>();
  const owner = new DirectoryCatalogs({
    async read<K extends keyof ProviderReadKinds>(
      _kind: K,
      _input: ProviderReadKinds[K]["input"],
      options: ProviderReadOptions,
    ): Promise<ProviderReadKinds[K]["result"]> {
      started.resolve();
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
      options.signal!.throwIfAborted();
      return [] as unknown as ProviderReadKinds[K]["result"];
    },
    release() {},
  }, { pending: 100 });
  const lease = owner.acquire("/p");
  const work = lease.get("agents", undefined, "warm");
  const rejected = assertRejects(() => work);
  await started.promise;
  lease.release();
  await rejected;
  await owner.stop();
  assertEquals(owner.size, 0);
});

Deno.test("catalog demand: real admission yields warm native I/O to an essential read without idle delay", async () => {
  const started = Promise.withResolvers<void>(), events: string[] = [];
  let count = 0;
  const client = {
    async read(_run: unknown, signal: AbortSignal) {
      if (++count === 1) {
        events.push("warm-started");
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            events.push("warm-joined");
            resolve();
          }, { once: true })
        );
        signal.throwIfAborted();
      }
      return { data: [] };
    },
  } as unknown as V2Client;
  const executor = new CatalogExecutor(() => client, {
    idlems: 60000,
    parallel: 1,
    background: false,
    batch: 100,
    slicems: 8,
    cpu: 1,
    memoryreserve: 0,
    maxpending: 2,
    publishrows: 64,
    retryms: 10,
    busyms: 100,
  }, 1);
  const signal = new AbortController().signal;
  try {
    const warm = executor.read("catalog.agents", { directory: "/p" }, {
      owner: "warm",
      signal,
      priority: "background",
    }).then(() => events.push("warm-complete"));
    await started.promise;
    await executor.read("catalog.skills", { directory: "/p" }, {
      owner: "essential",
      signal,
      priority: "user",
    }).then(() => events.push("essential-complete"));
    await warm;
    assertEquals(events, [
      "warm-started",
      "warm-joined",
      "essential-complete",
      "warm-complete",
    ]);
    assertEquals(count, 3);
  } finally {
    await executor.stop();
  }
});

Deno.test("catalog demand: a complete kind does not wait for another kind's warm-up", async () => {
  const pending = Promise.withResolvers<void>();
  let demands = 0;
  const owner = createDirectoryCatalogs({
    codecs: createCatalogCodecs(),
    watch: () => ({
      result: Promise.resolve({
        directory: "/p",
        generation: "g",
        revision: 0,
        paths: { style: "posix", separator: "/" },
        values: {
          agents: { state: "digesting", revision: 0 },
          skills: { state: "digesting", revision: 0 },
        },
      }),
      release() {},
    }),
    demand: () => {
      demands++;
      return pending.promise;
    },
    refresh: () => Promise.resolve(),
  });
  const lease = owner.acquire("/p");
  try {
    await lease.ready();
    const warm = lease.warm(["agents", "skills"]);
    await Promise.resolve();
    await Promise.resolve();
    owner.receive({
      t: "catalog.chunk",
      directory: "/p",
      generation: "g",
      revision: 1,
      transfer: "a",
      part: 0,
      last: true,
      kind: "agents",
      items: [],
    });
    await lease.ready("agents");
    assertEquals(demands, 1);
    assertEquals(lease.state.catalog?.values.skills?.state, "digesting");
    pending.resolve();
    await warm;
  } finally {
    pending.resolve();
    lease.release();
    owner.stop();
  }
});

Deno.test("catalog demand: files leave with the last subscription even while a standalone choice borrower remains", async () => {
  let files = 0;
  const owner = new DirectoryCatalogs({
    read<K extends keyof ProviderReadKinds>(
      kind: K,
    ): Promise<ProviderReadKinds[K]["result"]> {
      if (kind === "catalog.files") files++;
      return Promise.resolve(
        (kind === "catalog.files"
          ? { physical: "/p", items: [] }
          : []) as unknown as ProviderReadKinds[K]["result"],
      );
    },
    release() {},
  }, { pending: 100 });
  const standalone = owner.acquire("/p");
  let watch = owner.acquire("/p", true);
  try {
    await standalone.get("agents");
    await owner.demand("/p", { kinds: ["files"], intent: "consumer" });
    assertEquals(watch.snapshot().values.files?.state, "ready");
    watch.release();
    assertEquals(owner.size, 1);
    assertEquals(standalone.snapshot().values.files?.value, undefined);
    assertEquals(standalone.snapshot().values.agents?.state, "ready");
    watch = owner.acquire("/p", true);
    await owner.demand("/p", { kinds: ["files"], intent: "consumer" });
    assertEquals(files, 2);
  } finally {
    watch.release();
    standalone.release();
    await owner.stop();
  }
});

Deno.test("catalog demand: readiness follows an accepted native generation instead of its retired request failure", async () => {
  const pending = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const initial = (generation: string): DirectoryCatalog => ({
    directory: "/p",
    generation,
    revision: 0,
    paths: { style: "posix", separator: "/" },
    values: { agents: { state: "digesting", revision: 0 } },
  });
  const owner = createDirectoryCatalogs({
    codecs: createCatalogCodecs(),
    watch: () => ({ result: Promise.resolve(initial("old")), release() {} }),
    demand: () => {
      started.resolve();
      return pending.promise;
    },
    refresh: () => Promise.resolve(),
  });
  const lease = owner.acquire("/p");
  let settled = false, failure: unknown;
  const work = lease.ready("agents").then(() => {
    settled = true;
  }, (cause) => {
    failure = cause;
    settled = true;
  });
  try {
    await started.promise;
    owner.receive({ t: "catalog.snapshot", catalog: initial("new") });
    pending.reject(new Error("Retired native generation"));
    for (let n = 0; n < 10; n++) await Promise.resolve();
    assertEquals(failure, undefined);
    assertEquals(settled, false);
    owner.receive({
      t: "catalog.chunk",
      directory: "/p",
      generation: "new",
      revision: 1,
      transfer: "new",
      part: 0,
      last: true,
      kind: "agents",
      items: [],
    });
    await work;
    assertEquals(settled, true);
  } finally {
    pending.resolve();
    lease.release();
    owner.stop();
    await work;
  }
});

Deno.test("catalog demand: published kind failure remains the readiness authority", async () => {
  const pending = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const catalog: DirectoryCatalog = {
    directory: "/p",
    generation: "g",
    revision: 0,
    paths: { style: "posix", separator: "/" },
    values: {
      agents: {
        state: "digesting",
        revision: 0,
        value: [{ name: "kept", primary: true, mention: true }],
      },
    },
  };
  const owner = createDirectoryCatalogs({
    codecs: createCatalogCodecs(),
    watch: () => ({ result: Promise.resolve(catalog), release() {} }),
    demand: () => {
      started.resolve();
      return pending.promise;
    },
    refresh: () => Promise.resolve(),
  });
  const lease = owner.acquire("/p");
  let failure: unknown;
  const work = lease.ready("agents").catch((cause) => {
    failure = cause;
  });
  try {
    await started.promise;
    owner.receive({
      t: "catalog.snapshot",
      catalog: {
        ...catalog,
        revision: 1,
        values: {
          agents: {
            state: "unavailable",
            revision: 0,
            failure: {
              code: "native.unavailable",
              diagnosticID: "failure",
              retry: "same-intent",
            },
          },
        },
      },
    });
    pending.reject(new Error("Already published through the kind owner"));
    await work;
    assertEquals(failure, undefined);
    assertEquals(
      lease.view("agents").state.error,
      "Choices are unavailable. Try refreshing.",
    );
    assertEquals(lease.view("agents").state.value?.[0].name, "kept");
  } finally {
    pending.resolve();
    lease.release();
    owner.stop();
    await work;
  }
});
