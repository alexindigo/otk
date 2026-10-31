// SPDX-License-Identifier: LGPL-3.0-only
import { cfg } from "../../support/config.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { bounded, resources, tempDir, test } from "../../support/resources.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../../support/opencode.ts";

test("public worker port publishes real native totals and recovers committed metadata after restart", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  const session = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Worker digest" },
  });
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
          total?: { calls: number };
        };
      };
    }
  >();
  const options = {
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        url: oc.url,
        username: "opencode",
        password: "",
        db: oc.db,
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
            total?: { calls: number };
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
  const bridge = new DigestBridge(options);
  try {
    await bridge.start();
    const catalog = await bridge.catalog(1, new AbortController().signal);
    assertEquals(
      catalog.entries.some((entry) => entry.id === session.id),
      true,
    );
    await waitFor(
      () => summaries.get(session.id),
      (value) => value?.delta.summary.state === "ready",
    );
    assertEquals(summaries.get(session.id)?.delta.summary.messageCount, 0);
    for (let round = 0; round < 3; round++) {
      fake.queue({ chunks: ["Digest reply"] });
      await oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: {
          parts: [{ type: "text", text: "Digest prompt" }],
          model: { providerID: "fake", modelID: "scripted" },
        },
      });
      bridge.observe(1, [{
        sessionID: session.id,
        revision: round + 1,
        reason: "messages",
      }]);
      await waitFor(
        () => summaries.get(session.id),
        (value) =>
          value?.delta.summary.state === "ready" &&
          (value.delta.summary.total?.calls ?? 0) >= round + 1,
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
  const restarted = new DigestBridge({
    ...options,
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
    await restarted.start();
    await restarted.catalog(2, new AbortController().signal);
    await waitFor(
      () => summaries.get(session.id),
      (value) =>
        value?.delta.summary.state === "ready" &&
        (value.delta.summary.total?.calls ?? 0) >= 3,
    );
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
  } finally {
    await restarted.stop();
  }
  let closing: Promise<void> | undefined;
  const interrupted = new DigestBridge({
    ...options,
    metadata: () => {
      closing ??= interrupted.stop();
    },
  });
  await assertRejects(() => interrupted.start(), DOMException, "stopped");
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
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: () => {},
  });
  await assertRejects(() => bridge.start(), Error, "Unknown digest provider");
  await bridge.stop();
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
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: (value) => {
      states.set(value.sessionID, value.delta.summary.state);
    },
  });
  try {
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
