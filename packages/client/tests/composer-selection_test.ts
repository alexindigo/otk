// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { AgentOption, ModelCatalog, ModelRef } from "@otk/protocol";
import {
  type ComposerConnection,
  createComposerSelection,
  createDrafts,
  emptyDraft,
  type StateFactory,
} from "../mod.ts";

const first = { provider: "one", model: "first" },
  second = { provider: "two", model: "second" };
const catalog: ModelCatalog = {
  default: first,
  providers: [
    {
      id: "one",
      name: "One",
      models: [{
        id: "first",
        name: "First",
        status: "active",
        variants: ["low", "high"],
        free: false,
      }],
    },
    {
      id: "two",
      name: "Two",
      models: [{
        id: "second",
        name: "Second",
        status: "active",
        variants: ["high"],
        free: false,
      }],
    },
  ],
};
const agents: AgentOption[] = [{ name: "build" }, { name: "plan" }, {
  name: "review",
  model: second,
  variant: "high",
}];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  load?: {
    agents?(): Promise<AgentOption[]>;
    models?(): Promise<ModelCatalog>;
  },
  initialConnection?: ComposerConnection,
  factory?: StateFactory,
) {
  const drafts = createDrafts(), write = drafts.writer("server/session");
  let connection: ComposerConnection = initialConnection ??
    { key: "socket-1", connected: true, agents: true, models: true };
  const prefs = {
    "models.favourite": [] as ModelRef[],
    "models.recent": [] as ModelRef[],
  };
  const writes: { key: string; value: ModelRef[] }[] = [];
  const owner = createComposerSelection({
    factory,
    draft: () => drafts.get("server/session"),
    change: write,
    context: () => undefined,
    connection: () => connection,
    load: {
      agents: load?.agents ?? (() => Promise.resolve(agents)),
      models: load?.models ?? (() => Promise.resolve(catalog)),
    },
    prefs: {
      get: () => prefs,
      set: (key, value) => {
        writes.push({ key, value });
        prefs[key] = value;
        return Promise.resolve();
      },
    },
  });
  owner.connect();
  return {
    owner,
    write,
    prefs,
    writes,
    connection: (next: ComposerConnection) => {
      connection = next;
      owner.connect();
    },
  };
}

Deno.test("composer owns initial readiness, refresh coalescing, errors and last good catalog", async () => {
  let pending = deferred<ModelCatalog>(), calls = 0;
  const f = fixture({
    models: () => {
      calls++;
      return pending.promise;
    },
  });
  assertEquals(f.owner.state.models.loading, true);
  const ready = f.owner.ready(), joined = f.owner.refreshModels();
  await Promise.resolve();
  assertEquals(calls, 1);
  pending.resolve(catalog);
  await Promise.all([ready, joined]);
  assertEquals(f.owner.selection().input.model, first);
  pending = deferred<ModelCatalog>();
  const failed = f.owner.refreshModels();
  assertEquals(f.owner.state.models.value, catalog);
  pending.reject(new Error("catalog offline"));
  await failed;
  assertEquals(f.owner.state.models.error, "catalog offline");
  assertEquals(f.owner.state.models.value, catalog);
  await f.owner.ready();
  assertEquals(calls, 2, "Readiness does not repeatedly retry a known failure");
  pending = deferred<ModelCatalog>();
  const retry = f.owner.refreshModels();
  pending.resolve({ providers: [] });
  await retry;
  assertEquals(f.owner.state.models.error, "");
  assertEquals(f.owner.state.models.value, { providers: [] });
  f.owner.dispose();
});

Deno.test("composer logic remains invocation-current when a StateFactory publishes its revision later", async () => {
  let publish!: () => void, calls = 0, notices = 0;
  const factory: StateFactory = <T extends object>(initial: T) => {
    const queued = structuredClone(initial),
      listeners = new Set<(state: T) => void>();
    publish = () => {
      Object.assign(initial, queued);
      for (const listener of listeners) listener(initial);
    };
    return {
      state: initial,
      update(change: (value: T) => void) {
        change(queued);
      },
      reconcile<V extends object>(target: V, value: V) {
        Object.assign(target, value);
      },
      subscribe(listener: (state: T) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  };
  const f = fixture(
    {
      agents: () => {
        calls++;
        return Promise.resolve(agents);
      },
      models: () => {
        calls++;
        return Promise.resolve(catalog);
      },
    },
    undefined,
    factory,
  );
  const release = f.owner.subscribe(() => notices++);
  try {
    await f.owner.ready();
    assertEquals(calls, 2);
    assertEquals(f.owner.state.connected, true);
    assertEquals(f.owner.selection().input, {
      agent: "build",
      model: first,
      variant: undefined,
    });
    assertEquals(notices, 0);
    publish();
    assertEquals(notices, 1);
  } finally {
    release();
    f.owner.dispose();
  }
});

Deno.test("composer reconnect never joins or applies old connection work, even while an old readiness call is waiting", async () => {
  const requests = [
    deferred<ModelCatalog>(),
    deferred<ModelCatalog>(),
    deferred<ModelCatalog>(),
    deferred<ModelCatalog>(),
  ];
  let calls = 0;
  const f = fixture({ models: () => requests[calls++].promise });
  const beforeReconnect = f.owner.ready();
  await Promise.resolve();
  f.connection({
    key: "socket-2",
    connected: true,
    agents: true,
    models: true,
  });
  const afterReconnect = f.owner.ready();
  await Promise.resolve();
  assertEquals(calls, 2);
  requests[1].resolve(catalog);
  await Promise.all([beforeReconnect, afterReconnect]);
  requests[0].resolve({ providers: [] });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(f.owner.state.models.value, catalog);
  assertEquals(f.owner.state.models.loading, false);
  f.connection({
    key: "socket-3",
    connected: true,
    agents: true,
    models: true,
  });
  await Promise.resolve();
  f.connection({
    key: "socket-4",
    connected: true,
    agents: true,
    models: true,
  });
  const latest = f.owner.ready();
  await Promise.resolve();
  requests[3].resolve({ ...catalog, default: second });
  await latest;
  requests[2].reject(new Error("old connection failed"));
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(f.owner.state.models.error, "");
  assertEquals(f.owner.selection().model.value, second);
  f.owner.dispose();
});

Deno.test("composer late agent cycle cannot overwrite a newer manual choice", async () => {
  const pending = deferred<AgentOption[]>();
  let hold = false;
  const f = fixture({
    agents: () => hold ? pending.promise : Promise.resolve(agents),
  });
  await f.owner.ready();
  hold = true;
  const cycle = f.owner.cycleAgent(1);
  await Promise.resolve();
  f.owner.chooseAgent("review");
  pending.resolve(agents);
  await cycle;
  assertEquals(f.owner.selection().input, {
    agent: "review",
    model: second,
    variant: "high",
  });
  f.owner.dispose();
});

Deno.test("composer disposal suppresses late loads and capability absence performs no load", async () => {
  const pending = deferred<ModelCatalog>();
  const f = fixture({ models: () => pending.promise });
  let notices = 0;
  const stop = f.owner.subscribe(() => notices++);
  await Promise.resolve();
  f.owner.dispose();
  const atDispose = notices;
  pending.resolve(catalog);
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(notices, atDispose);
  assertEquals(f.owner.state.models.value, undefined);
  f.owner.chooseModel(second);
  assertEquals(f.owner.selection().model.value, undefined);
  stop();
  let calls = 0;
  const g = fixture({
    models: () => {
      calls++;
      return Promise.resolve(catalog);
    },
  }, { key: "legacy", connected: true, agents: false, models: false });
  await g.owner.ready();
  assertEquals(g.owner.state.models.available, false);
  assertEquals(g.owner.state.agents.available, false);
  assertEquals(g.owner.selection().model.value, undefined);
  assertEquals(calls, 0);
  g.owner.dispose();
});

Deno.test("composer cycles share client choice intents and shell projection omits variant without losing the normal choice", async () => {
  const f = fixture();
  await f.owner.ready();
  await Promise.all([f.owner.cycleAgent(1), f.owner.cycleAgent(1)]);
  assertEquals(f.owner.selection().input, {
    agent: "review",
    model: second,
    variant: "high",
  });
  f.owner.cycleVariant();
  assertEquals(f.owner.selection().variant.value, undefined);
  f.owner.cycleVariant();
  assertEquals(f.owner.selection().variant.value, "high");
  f.write((draft) => ({ ...draft, mode: "shell" }));
  const shellDraft = f.write((draft) => draft);
  assertEquals(f.owner.selection().applies, {
    agent: true,
    model: true,
    variant: false,
  });
  assertEquals(f.owner.selection().input, { agent: "review", model: second });
  f.owner.cycleVariant();
  assertStrictEquals(f.write((draft) => draft), shellDraft);
  f.write((draft) => ({ ...draft, mode: "normal" }));
  assertEquals(f.owner.selection().variant.value, "high");
  f.owner.dispose();
});

Deno.test("composer serializes favourite writes, recovers from failure and records only successful normal sends using captured model identity", async () => {
  const drafts = createDrafts(),
    prefs = {
      "models.favourite": [] as ModelRef[],
      "models.recent": [] as ModelRef[],
    };
  const calls: {
    key: string;
    value: ModelRef[];
    done: ReturnType<typeof deferred<void>>;
  }[] = [];
  const owner = createComposerSelection({
    draft: () => emptyDraft(),
    change: drafts.writer("s"),
    context: () => undefined,
    connection: () => ({
      key: "none",
      connected: false,
      agents: false,
      models: false,
    }),
    load: {
      agents: () => Promise.resolve([]),
      models: () => Promise.resolve(catalog),
    },
    prefs: {
      get: () => prefs,
      set: (key, value) => {
        const done = deferred<void>();
        calls.push({ key, value, done });
        return done.promise.then(() => {
          prefs[key] = value;
        });
      },
    },
  });
  const add = owner.toggleFavourite(first),
    remove = owner.toggleFavourite(first);
  const captured = { ...second };
  const recent = owner.recordSent({ model: captured }, "normal", false);
  captured.model = "changed after send";
  await Promise.resolve();
  assertEquals(calls.length, 1);
  calls[0].done.resolve();
  await add;
  await Promise.resolve();
  assertEquals(calls[1].value, []);
  calls[1].done.resolve();
  await remove;
  await Promise.resolve();
  assertEquals(calls[2].value, [second]);
  calls[2].done.resolve();
  await recent;
  await owner.recordSent({ model: first }, "shell", false);
  await owner.recordSent({ model: first }, "normal", true);
  assertEquals(calls.length, 3);
  const failed = owner.toggleFavourite(first);
  await Promise.resolve();
  calls[3].done.reject(new Error("save failed"));
  await assertRejects(() => failed, Error, "save failed");
  const recovered = owner.toggleFavourite(second);
  await Promise.resolve();
  calls[4].done.resolve();
  await recovered;
  assertEquals(prefs["models.favourite"], [second]);
  owner.dispose();
});

Deno.test("composer readiness allows the current draft choice made during first load to become the submitted selection", async () => {
  const pending = deferred<ModelCatalog>(),
    f = fixture({ models: () => pending.promise });
  const submission = f.owner.ready().then(() => f.owner.selection().input);
  f.owner.chooseModel(second);
  f.owner.chooseVariant("high");
  assertEquals(f.owner.selection().input.model, second);
  assertEquals(f.owner.selection().input.variant, "high");
  pending.resolve(catalog);
  assertEquals(await submission, {
    agent: "build",
    model: second,
    variant: "high",
  });
  f.owner.dispose();
});
