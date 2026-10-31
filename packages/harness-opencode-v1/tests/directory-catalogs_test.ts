// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DirectoryCatalogs } from "../catalogs.ts";
import type { ProviderReadPort } from "@otk/harness";
import { catalogModelCodec } from "@otk/harness";
import { PendingQuestions } from "../pending-questions.ts";
import { Client } from "../client.ts";
import { questions } from "../questions.ts";
import { cfg } from "../../../tests/support/config.ts";
import type { Directory } from "../directory.ts";
import { bounded } from "../../../tests/support/resources.ts";
import { AgentColors, mapAgents } from "../agents.ts";

Deno.test("directory catalogs share acquisition, coalesce invalidations and retire demand", async () => {
  let reads = 0;
  const held = Promise.withResolvers<unknown>();
  const signals: AbortSignal[] = [];
  const reader = {
    async read(
      _kind: string,
      _input: unknown,
      options: { signal: AbortSignal },
    ) {
      signals.push(options.signal);
      reads++;
      if (reads === 1) return await held.promise;
      return [{ name: "review", primary: true, mention: false }];
    },
    release() {},
  } as unknown as ProviderReadPort;
  const owner = new DirectoryCatalogs(reader, { pending: 128 });
  const a = owner.acquire("/project");
  const b = owner.acquire("/project");
  assertEquals(a.snapshot().values.files?.state, "digesting");
  assertEquals(
    reads,
    0,
    "Unrequested preparing kinds cause no native acquisition",
  );
  const one = a.get("agents");
  const two = b.get("agents");
  await Promise.resolve();
  await Promise.resolve();
  owner.invalidate("/project", ["agents"]);
  owner.invalidate("/project", ["agents"]);
  held.resolve([{ name: "build", primary: true, mention: false }]);
  assertEquals(await one, [{ name: "review", primary: true, mention: false }]);
  assertEquals(await two, await b.get("agents"));
  assertEquals(reads, 2);
  a.release();
  assertEquals(await b.get("agents"), await two);
  b.release();
  assertEquals(owner.size, 0);
  const late = owner.acquire("/project");
  assertEquals(await late.get("agents"), [{
    name: "review",
    primary: true,
    mention: false,
  }]);
  assertEquals(reads, 3);
  late.release();
  await assertRejects(() => late.get("agents"));
  await owner.stop();
});

Deno.test("native instance invalidation refreshes borrowed catalogs and fences the prior generation", async () => {
  const held = Promise.withResolvers<unknown>();
  let reads = 0;
  const owner = new DirectoryCatalogs({
    read() {
      return ++reads === 1
        ? held.promise
        : Promise.resolve([{ name: "new", primary: true, mention: true }]);
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  const lease = owner.acquire("/project");
  const generation = lease.snapshot().generation;
  const old = lease.get("agents");
  const rejected = assertRejects(() => old);
  await Promise.resolve();
  owner.reset("/project");
  assert(lease.snapshot().generation !== generation);
  held.resolve([{ name: "old", primary: true, mention: true }]);
  await rejected;
  assertEquals((await lease.get("agents"))[0].name, "new");
  owner.invalidate("/idle", ["agents"]);
  assertEquals(reads, 2);
  lease.release();
  await owner.stop();
});

Deno.test("only file demand watches the project; file/config edits never refresh configuration catalogs", async () => {
  let watches = 0;
  const changes = Promise.withResolvers<Deno.FsEvent>();
  const closed = Promise.withResolvers<void>();
  const calls: string[] = [];
  const owner = new DirectoryCatalogs({
    read(kind: string) {
      calls.push(kind);
      return Promise.resolve(
        kind === "catalog.files" ? { physical: "/project", items: [] } : [],
      );
    },
    release() {},
  } as unknown as ProviderReadPort, {
    pending: 4,
    watch(paths) {
      watches++;
      assertEquals(paths, ["/project"]);
      return {
        close: () => closed.resolve(),
        [Symbol.dispose]: () => closed.resolve(),
        async *[Symbol.asyncIterator]() {
          yield await changes.promise;
          await closed.promise;
        },
      } as Deno.FsWatcher;
    },
  });
  const lease = owner.acquire("/project");
  await lease.get("agents");
  assertEquals(watches, 0);
  await lease.get("files");
  assertEquals(watches, 1);
  changes.resolve({ kind: "modify", paths: ["/project/opencode.json"] });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assertEquals(calls.filter((kind) => kind === "catalog.agents").length, 1);
  assertEquals(calls.filter((kind) => kind === "catalog.files").length, 2);
  lease.release();
  await owner.stop();
});

Deno.test("complete file traversal retains all candidates and relists only changed parents", async () => {
  const calls: string[] = [];
  let failed = false;
  let directories = ["a", "b"];
  const owner = new DirectoryCatalogs({
    read(_kind: string, input: { path: string }) {
      calls.push(input.path);
      if (input.path && !directories.includes(input.path)) {
        return Promise.reject(new Error("Directory removed"));
      }
      if (failed && input.path === "a") {
        return Promise.reject(new Error("Unreadable subtree"));
      }
      return Promise.resolve({
        physical: "/project/" + input.path,
        items: input.path
          ? Array.from(
            { length: 220 },
            (_, i) => ({
              path: `${input.path}/${i}.txt`,
              canonicalPath: `/project/${input.path}/${i}.txt`,
              directory: false,
            }),
          )
          : directories.map((path) => ({
            path,
            canonicalPath: `/project/${path}`,
            directory: true,
          })),
      });
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  const lease = owner.acquire("/project");
  assertEquals((await lease.get("files")).length, 442);
  owner.invalidate("/project", ["files"], ["/project/a/new.txt"]);
  await lease.get("files");
  assertEquals(calls, ["", "a", "b", "a"]);
  owner.invalidate("/project", ["files"], ["/project/new.txt"]);
  await lease.get("files");
  assertEquals(
    calls,
    ["", "a", "b", "a", ""],
    "Root changes preserve unchanged subtree inventories",
  );
  failed = true;
  owner.invalidate("/project", ["files"], ["/project/a/new.txt"]);
  await assertRejects(() => lease.get("files"));
  const state = lease.snapshot().values.files!;
  assertEquals(state.state, "unavailable");
  assertEquals(state.value!.length, 442);
  failed = false;
  directories = ["b"];
  const removedReads = calls.filter((path) => path === "a").length;
  owner.invalidate("/project", ["files"], [
    "/project/a/removed.txt",
    "/project/a",
  ]);
  assertEquals((await lease.get("files")).length, 221);
  assertEquals(
    calls.filter((path) => path === "a").length,
    removedReads,
    "Parent deletion retires stale descendant invalidations",
  );
  lease.release();
  await owner.stop();
});

Deno.test("pending question capture cannot resurrect replies, and answering uses the asking directory without refetch", async () => {
  const pending = new PendingQuestions(4);
  const request = {
    id: "q",
    sessionID: "opcv1-child",
    questions: [{
      header: "Pick",
      text: "Choose",
      options: [{ label: "Yes", description: "Proceed" }],
      custom: false,
      multiple: false,
    }],
  };
  const capture = pending.capture("/asking");
  pending.upsert(request, "/asking");
  pending.remove("q");
  assert(capture.commit([request]));
  assertEquals(pending.size, 0);
  pending.upsert(request, "/asking");
  const calls: URL[] = [];
  const feature = questions(
    new Client(cfg().harness, (input) => {
      calls.push(new URL(String(input)));
      return Promise.resolve(Response.json(true));
    }),
    {
      resolve: () => Promise.resolve("/wrong-directory"),
    } as unknown as Directory,
    () => undefined,
    pending,
  );
  await assertRejects(() => feature.answerQuestion("q", [["No"]]));
  assertEquals(calls.length, 0);
  await feature.answerQuestion("q", [["Yes"]]);
  assertEquals(
    calls.map((url) => [url.pathname, url.searchParams.get("directory")]),
    [["/question/q/reply", "/asking"]],
  );
});

Deno.test("model catalog codecs preserve complete metadata in one-row chunks and reject invalid identities", () => {
  const value = {
    default: { provider: "p", model: "m" },
    providers: [{
      id: "p",
      name: "Provider",
      models: [{
        id: "m",
        name: "Model",
        variants: ["high"],
        status: "active" as const,
        free: false,
        contextLimit: 100,
      }],
    }],
  };
  const chunks = [...catalogModelCodec.chunks(value, 1)];
  assert(chunks.every((items) => items.length === 1));
  const builder = catalogModelCodec.create();
  for (const items of chunks) builder.append(items);
  assertEquals(builder.finish(), value);
  assertThrows(() =>
    builder.append([{ kind: "provider", id: "p", name: "Duplicate" }])
  );
  assertThrows(() =>
    catalogModelCodec.create().append([{
      kind: "model",
      providerID: "missing",
      model: value.providers[0].models[0],
    }])
  );
});

Deno.test("last directory lease release cancels and joins native demand, and later cleanup is harmless", async () => {
  const started = Promise.withResolvers<void>();
  let joined = false;
  const catalog = new DirectoryCatalogs({
    async read(
      _kind: string,
      _input: unknown,
      options: { signal: AbortSignal },
    ) {
      started.resolve();
      try {
        return await new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          )
        );
      } finally {
        joined = true;
      }
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  const lease = catalog.acquire("/retired");
  const pending = lease.get("agents");
  const rejected = assertRejects(() => pending);
  await started.promise;
  await catalog.stop();
  await rejected;
  assert(joined);
  assertEquals(catalog.size, 0);
  lease.release();
  lease.release();
});

Deno.test("verified native catalog events invalidate only their demanded directory and kind", async () => {
  const calls: string[] = [];
  const owner = new DirectoryCatalogs({
    read(kind: string, input: { directory: string }) {
      calls.push(JSON.stringify([kind, input.directory]));
      return Promise.resolve(
        kind === "catalog.models" ? { providers: [] } : [],
      );
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  const lease = owner.acquire("/project");
  await lease.get("models");
  await lease.get("agents");
  assertEquals(
    owner.event({
      directory: "/project",
      payload: { type: "catalog.updated", properties: {} },
    }),
    ["models"],
  );
  await lease.get("models");
  assertEquals(calls, [
    JSON.stringify(["catalog.models", "/project"]),
    JSON.stringify(["catalog.agents", "/project"]),
    JSON.stringify(["catalog.models", "/project"]),
  ]);
  owner.event({
    directory: "/idle",
    payload: { type: "reference.updated", properties: {} },
  });
  assertEquals(calls.length, 3);
  assertEquals(
    owner.event({
      directory: "/project",
      payload: { type: "unrelated", properties: {} },
    }),
    undefined,
  );
  lease.release();
  await owner.stop();
});

Deno.test("file watch failure reopens observation before reconciling the complete file catalog", async () => {
  const fail = Promise.withResolvers<void>();
  const reopened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let watches = 0, reads = 0;
  const owner = new DirectoryCatalogs({
    read() {
      reads++;
      return Promise.resolve({ physical: "/project", items: [] });
    },
    release() {},
  } as unknown as ProviderReadPort, {
    pending: 4,
    watch() {
      const number = ++watches;
      if (number === 2) reopened.resolve();
      return {
        close: () => {
          if (number !== 1) closed.resolve();
        },
        [Symbol.dispose]: () => {
          if (number !== 1) closed.resolve();
        },
        async *[Symbol.asyncIterator]() {
          if (number === 1) {
            await fail.promise;
            throw new Error("Watch continuity lost");
          }
          await closed.promise;
          yield { kind: "other" as const, paths: [] };
        },
      } as Deno.FsWatcher;
    },
  });
  const lease = owner.acquire("/project");
  try {
    await lease.get("files");
    fail.resolve();
    await bounded("file watcher reopens", reopened.promise, 1000);
    await lease.get("files");
    assert(reads >= 2);
  } finally {
    lease.release();
    await owner.stop();
  }
});

Deno.test("first transcript color lookup borrows an already-ready directory inventory synchronously", async () => {
  const catalog = new DirectoryCatalogs({
    read() {
      return Promise.resolve([{
        name: "review",
        color: "#12abEF",
        primary: true,
        mention: true,
      }]);
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  await catalog.get("/project", "agents");
  const colors = new AgentColors(
    new Client(cfg().harness, () => {
      throw new Error("No second acquisition");
    }),
    () => {},
    () => undefined,
    catalog,
  );
  try {
    assertEquals(colors.peek("/project")?.get("review"), "#12abEF");
  } finally {
    colors.clear();
    await catalog.stop();
  }
});

Deno.test("shared agent mapping retains hidden-agent decoration without making it selectable", () => {
  const values = mapAgents([{
    name: "internal",
    mode: "primary",
    hidden: true,
    color: "#abcdef",
  }]);
  assertEquals(
    values.map(({ name, color, primary, mention }) => ({
      name,
      color,
      primary,
      mention,
    })),
    [{ name: "internal", color: "#abcdef", primary: false, mention: false }],
  );
});

Deno.test("color view keeps the shared acquisition's reported color during a held native refresh", async () => {
  const initial = [{
    name: "reviewer",
    color: "#12abEF" as const,
    primary: true,
    mention: false,
  }];
  const refreshed = [{ ...initial[0], color: "#abcdef" as const }];
  const held = Promise.withResolvers<typeof refreshed>();
  const started = Promise.withResolvers<void>();
  let reads = 0, directReads = 0;
  const catalog = new DirectoryCatalogs({
    read() {
      if (++reads === 1) return Promise.resolve(initial);
      started.resolve();
      return held.promise;
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  const lease = catalog.acquire("/project");
  const colors = new AgentColors(
    new Client(cfg().harness, () => {
      directReads++;
      throw new Error("A second color source is forbidden");
    }),
    () => {},
    () => undefined,
    catalog,
  );
  try {
    await lease.get("agents");
    catalog.invalidate("/project", ["agents"]);
    await started.promise;
    assertEquals(lease.snapshot().values.agents?.state, "digesting");
    assertEquals(lease.snapshot().values.agents?.value?.[0].color, "#12abEF");
    assertEquals(
      colors.peek("/project", "opcv1-session")?.get("reviewer"),
      "#12abEF",
    );
    held.resolve(refreshed);
    assertEquals((await colors.get("/project")).get("reviewer"), "#abcdef");
    assertEquals(reads, 2);
    assertEquals(directReads, 0);
  } finally {
    held.resolve(refreshed);
    colors.clear();
    lease.release();
    await catalog.stop();
  }
});

Deno.test("an unresolved color directory never falls back to a second native acquisition", async () => {
  let reads = 0;
  const catalog = new DirectoryCatalogs({
    read() {
      throw new Error("No directory demand");
    },
    release() {},
  } as unknown as ProviderReadPort, { pending: 4 });
  const colors = new AgentColors(
    new Client(cfg().harness, () => {
      reads++;
      return Promise.resolve(Response.json([]));
    }),
    () => {},
    () => undefined,
    catalog,
  );
  try {
    assertEquals((await colors.get()).size, 0);
    assertEquals(reads, 0);
  } finally {
    colors.clear();
    await catalog.stop();
  }
});
