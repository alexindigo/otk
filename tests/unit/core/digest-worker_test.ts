// SPDX-License-Identifier: LGPL-3.0-only
import { type Derived, derivedValue } from "@otk/protocol";
import { cfg } from "../../support/config.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { StoppedError } from "@otk/protocol";
import { bounded, resources, tempDir, test } from "../../support/resources.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import { waitFor } from "../../support/opencode.ts";
import {
  nativeDigest,
  nativeHarness,
  selectedNative,
  startHarness,
} from "../../support/native-testing.ts";

test("project-only worker startup has no phantom session enumeration or unrequested progress", async () => {
  const statePath = await tempDir("project-only-progress-");
  const settings = cfg();
  settings.harness.db = statePath + "/absent.db";
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: settings,
    policy: settings.digest,
    publish() {},
    diagnostic() {},
  });
  try {
    await bridge.start();
    await waitFor(
      () => bridge.progress().find((value) => value.directory === undefined),
      (value) => value !== undefined,
    );
    const value = bridge.progress().find((value) =>
      value.directory === undefined
    )!;
    assertEquals(value.phase, "ready");
    assertEquals(value.eligible, 0);
    assertEquals(value.queued, 0);
  } finally {
    await bridge.stop();
  }
});

test("public worker port publishes real native totals and recovers committed metadata after restart", async () => {
  const fake = new FakeLlm();
  const oc = await selectedNative(fake);
  const session = await oc.createSession("Worker digest");
  const nativeReader = nativeHarness(oc);
  resources().defer(
    "worker native transcript observer",
    () => nativeReader.core.stop(),
  );
  await startHarness(nativeReader);
  const statePath = await tempDir("digest-worker-");
  const turnKeys = new Set<string>();
  const summaries = new Map<
    string,
    {
      revision: number;
      delta: {
        summary: {
          state: string;
          messageCount?: number;
          total?: Derived<{ calls: number }>;
        };
      };
    }
  >();
  const options = {
    statePath,
    ...nativeDigest(oc),
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 2,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: (
      value: {
        sessionID: string;
        revision: number;
        delta: {
          turns: { upsert: Record<string, unknown>; remove: string[] };
          summary: {
            state: string;
            messageCount?: number;
            total?: Derived<{ calls: number }>;
          };
        };
      },
    ) => {
      summaries.set(value.sessionID, value);
      for (const key of Object.keys(value.delta.turns.upsert)) {
        turnKeys.add(key);
      }
      for (const key of value.delta.turns.remove) turnKeys.delete(key);
    },
  };
  const open = async (target: DigestBridge, connection: number) => {
    target.scope("viewer", { sessions: [session.id] });
    await target.start();
    // Both lifetimes acquire the selected key explicitly. Catalog replay is
    // optional background work, not the selected-turn acquisition contract.
    await target.hydrate([session.id], new AbortController().signal);
    return await target.catalog(connection, new AbortController().signal);
  };
  const bridge = new DigestBridge(options);
  try {
    const catalog = await open(bridge, 1);
    assertEquals(
      catalog.entries.some((entry) => entry.id === session.id),
      true,
    );
    await waitFor(
      () => summaries.get(session.id),
      (value) => value?.delta.summary.state === "ready",
    );
    assertEquals(summaries.get(session.id)?.delta.summary.messageCount, 0);
    await waitFor(
      () => bridge.progress().find((value) => value.directory === undefined),
      (value) => value?.phase === "ready",
    );
    assertEquals(bridge.progress()[0].eligible, catalog.entries.length);
    assertEquals(bridge.progress()[0].completed, catalog.entries.length);
    for (let round = 0; round < 3; round++) {
      fake.queue({ chunks: ["Digest reply"] });
      await oc.prompt(session.id, "Digest prompt");
      await waitFor(
        () => nativeReader.core.listMessages(session.id, {}),
        (page) =>
          page.items.filter((row) =>
            row.role === "assistant" && row.time.completed !== undefined
          ).length >= round + 1,
      );
      bridge.observe(1, [{
        sessionID: session.id,
        revision: round + 1,
        reason: "messages",
      }]);
      await waitFor(
        () => summaries.get(session.id),
        (value) =>
          value?.delta.summary.state === "ready" &&
          (derivedValue(value.delta.summary.total)?.calls ?? 0) >= round + 1,
      );
      assertEquals(
        summaries.get(session.id)?.delta.summary.messageCount! >= 2,
        true,
      );
    }
  } finally {
    await bridge.stop();
  }
  summaries.clear();
  turnKeys.clear();
  const failures: string[][] = [];
  const diagnostics: Error[] = [];
  const restarted = new DigestBridge({
    ...options,
    diagnostic: (error) => diagnostics.push(error),
    unready: (ids) => {
      failures.push([...ids]);
      for (const id of ids) {
        const value = summaries.get(id);
        if (value) value.delta.summary.state = "digesting";
      }
      restarted.release("fault");
    },
  });
  try {
    await open(restarted, 2);
    await waitFor(
      () => summaries.get(session.id),
      (value) =>
        value?.delta.summary.state === "ready" &&
        (derivedValue(value.delta.summary.total)?.calls ?? 0) >= 3,
    );
    await waitFor(() => turnKeys.size, (count) => count === 3);
    assertEquals(turnKeys.size, 3);
    const beforeCrash = summaries.get(session.id)!.revision;
    // Deliberately violate the typed scope port to force an actual worker fault.
    // No production test mode, worker monkey-patch or second writer is involved.
    Reflect.apply(restarted.scope, restarted, ["fault", {
      sessions: undefined,
    }]);
    await waitFor(() => failures.length, (count) => count === 1);
    await waitFor(
      () => summaries.get(session.id),
      (value) =>
        value?.delta.summary.state === "ready" && value.revision > beforeCrash,
    );
    assertEquals(failures, [[session.id]]);
    assertEquals(diagnostics.length, 1);
  } finally {
    await restarted.stop();
  }
  assertEquals(
    diagnostics.length,
    1,
    "Clean close reported a second worker failure",
  );
  let closing: Promise<void> | undefined;
  const interrupted = new DigestBridge({
    ...options,
    metadata: () => {
      closing ??= interrupted.stop();
    },
  });
  // Startup no longer replays retained sessions; cancellation belongs to keyed demand.
  await interrupted.start();
  await assertRejects(
    () => interrupted.hydrate([session.id], new AbortController().signal),
    StoppedError,
    "stopped",
  );
  await closing;
});

test("last bridge caller release aborts the worker's actual HTTP read and admits the next catalog", async () => {
  const statePath = await tempDir("digest-cancel-");
  const started = Promise.withResolvers<void>();
  let aborted = false, holding = true, catalogs = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      if (new URL(request.url).pathname === "/global/health") {
        return Response
          .json({ healthy: true });
      }
      catalogs++;
      if (!holding) return Response.json([]);
      started.resolve();
      return new Promise<Response>((resolve) =>
        request.signal.addEventListener("abort", () => {
          aborted = true;
          resolve(Response.json([]));
        }, { once: true })
      );
    },
  );
  resources().defer("cancel fixture HTTP", () => server.shutdown());
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        username: "",
        password: "",
        db: statePath + "/absent.db",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 2,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: () => {},
  });
  try {
    const first = new AbortController(), second = new AbortController();
    const one = bridge.catalog(1, first.signal),
      two = bridge.catalog(1, second.signal);
    const rejectedOne = assertRejects(() => one, DOMException);
    const rejectedTwo = assertRejects(() => two, DOMException);
    await bounded("held native HTTP admission", started.promise);
    first.abort();
    await rejectedOne;
    assertEquals(aborted, false);
    second.abort();
    await rejectedTwo;
    await waitFor(() => aborted, (value) => value, 2000);
    holding = false;
    const result = await bridge.catalog(2, new AbortController().signal);
    assertEquals(result.entries, []);
    assertEquals(catalogs, 2);
    first.abort();
    second.abort();
    assertEquals(
      (await bridge.catalog(3, new AbortController().signal)).entries,
      [],
    );
  } finally {
    await bridge.stop();
  }
});

test("worker startup failure closes acquired state and stop still acknowledges", async () => {
  const statePath = await tempDir("digest-start-failure-");
  const bridge = new DigestBridge({
    statePath,
    provider: "missing-provider",
    native: {
      harness: {
        url: "http://127.0.0.1:1",
        db: statePath + "/missing.db",
        username: "",
        password: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 2,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: () => {},
  });
  await assertRejects(() => bridge.start(), Error, "Unknown digest provider");
  await bridge.stop();
});

test("retired worker step failure cannot publish unavailable into a new connection", async () => {
  const statePath = await tempDir("digest-retired-error-");
  const entered = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") {
        return Response.json([{
          id: "ses_one",
          projectID: "p",
          directory: "/p",
          title: "One",
          time: { created: 1, updated: 2 },
        }]);
      }
      return Response.json([]);
    },
  );
  resources().defer("retired error HTTP", () => server.shutdown());
  // Replace only the provider outcome in this test worker. The production
  // worker, scheduler, storage and publication path remain the real modules.
  const provider =
    new URL("../../../packages/harness-opencode-v1/digest.ts", import.meta.url)
      .href;
  const worker =
    new URL("../../../core/digest/worker.ts", import.meta.url).href;
  const entry = URL.createObjectURL(
    new Blob([`
    import { OpencodeV1DigestSink } from ${JSON.stringify(provider)};
    const step = OpencodeV1DigestSink.prototype.step;
    let first = true;
    const release = Promise.withResolvers();
    addEventListener("message", event => {
      if (event.data.t === "fixture.release") release.resolve();
    });
    OpencodeV1DigestSink.prototype.step = async function (...args) {
      if (first) {
        first = false;
        postMessage({t: "fixture.held"});
        await args[3].wait(release.promise);
        throw new Error("Retired step fixture outcome");
      }
      return await step.apply(this, args);
    };
    await import(${JSON.stringify(worker)});
    postMessage({t: "fixture.ready"});
  `], { type: "application/javascript" }),
  );
  const OriginalWorker = globalThis.Worker;
  let running: Worker | undefined;
  globalThis.Worker = class extends OriginalWorker {
    #ready = false;
    #queued: unknown[] = [];
    constructor(_url: string | URL, options?: WorkerOptions) {
      super(entry, options);
      running = this;
      this.addEventListener("message", (event) => {
        if (event.data.t === "fixture.held") entered.resolve();
        if (event.data.t === "fixture.ready") {
          this.#ready = true;
          for (const value of this.#queued) super.postMessage(value);
          this.#queued = [];
        }
      });
    }
    override postMessage(value: unknown): void {
      if (this.#ready) super.postMessage(value);
      else this.#queued.push(value);
    }
  };
  const states: string[] = [], errors: Error[] = [];
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        ...cfg().harness,
        url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        db: statePath + "/missing.db",
      },
      index: cfg().index,
      attachments: cfg().attachments,
    },
    policy: {
      ...cfg().digest,
      batch: 2,
      cpu: 1,
      memoryreserve: 1,
      idlems: 1,
      retryms: 10,
    },
    publish: (value) => {
      states.push(value.delta.summary.state);
    },
    diagnostic: (error) => {
      errors.push(error);
    },
  });
  try {
    bridge.scope("viewer", { sessions: ["opcv1-ses_one"] });
    await bridge.catalog(1, new AbortController().signal);
    await bounded("old provider step", entered.promise);
    const next = bridge.catalog(2, new AbortController().signal);
    next.catch(() => {});
    await waitFor(
      () => bridge.progress().some((value) => /:2:\d+$/.test(value.generation)),
      (value) => value,
    );
    states.length = 0;
    running!.postMessage({ t: "fixture.release" });
    await next;
    await waitFor(() => states.at(-1), (value) => value === "ready");
    assertEquals(states.includes("unavailable"), false);
    assertEquals(
      errors.some((error) => error.message.includes("Retired step fixture")),
      false,
    );
  } finally {
    running?.postMessage({ t: "fixture.release" });
    await bridge.stop();
    globalThis.Worker = OriginalWorker;
    URL.revokeObjectURL(entry);
  }
});

test("a malformed aggregate is scoped to its session and cannot starve another digest", async () => {
  const statePath = await tempDir("digest-scoped-error-");
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") {
        return Response.json(
          ["bad", "good"].map((id) => ({
            id: `ses_${id}`,
            directory: "/p",
            projectID: "p",
            title: id,
            time: { created: 1, updated: id === "bad" ? 2 : 1 },
          })),
        );
      }
      if (path === "/session/ses_bad/message") {
        return Response.json(["a", "b"].map((id) => ({
          info: {
            id,
            sessionID: "ses_bad",
            role: "assistant",
            parentID: "turn",
            agent: "build",
            providerID: "p",
            modelID: "m",
            time: { created: 2, completed: 3 },
            cost: 0,
            tokens: {
              input: Number.MAX_SAFE_INTEGER,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        })));
      }
      return Response.json([]);
    },
  );
  resources().defer("scoped error fixture HTTP", () => server.shutdown());
  const states = new Map<string, string>();
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        db: statePath + "/absent.db",
        username: "",
        password: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 2,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: (value) => {
      states.set(value.sessionID, value.delta.summary.state);
    },
  });
  try {
    bridge.scope("viewer", { sessions: [] });
    await bridge.catalog(1, new AbortController().signal);
    await waitFor(
      () => [...states],
      () =>
        states.get("opcv1-ses_bad") === "unavailable" &&
        states.get("opcv1-ses_good") === "ready",
      3000,
    );
  } finally {
    await bridge.stop();
  }
});
