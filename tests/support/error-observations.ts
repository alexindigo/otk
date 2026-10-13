// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { loadServiceConfig } from "../../sidecar/config/loader.ts";
import { Opencode1Adapter } from "../../sidecar/adapter/opencode1/adapter.ts";
import { StreamBuffers } from "../../sidecar/content/buffers.ts";
import type { IndexEntry } from "@otk/protocol";
import type { ContentOp } from "@otk/protocol";
import type { Session } from "../../sidecar/adapter/opencode1/types.ts";

export interface Observation {
  id: string;
  source: "http" | "event";
  message: string;
  kind?: string;
  ref?: string;
  status?: number;
  requestID?: string;
  operation?: string;
  eventID?: string;
  cleared?: boolean;
}
export interface ObservedState {
  revision: number;
  currentRequestID?: string;
  observations: Observation[];
}
export function observed(value: object): ObservedState {
  const state = Reflect.get(value, "errorState");
  assert(
    state && typeof state === "object",
    "Consumer has no identified error state",
  );
  assert(Number.isSafeInteger(state.revision) && state.revision >= 0);
  assert(Array.isArray(state.observations));
  for (const observation of state.observations) {
    assert(typeof observation.id === "string");
    assert(observation.source === "http" || observation.source === "event");
    assert(typeof observation.message === "string");
  }
  return state;
}
export async function observationFixture() {
  const cfg = loadServiceConfig({
    defaultsPath: fromFileUrl(
      new URL("../../defaults/otk.toml", import.meta.url),
    ),
    env: {},
  }).config;
  const root = fromFileUrl(new URL("../../.test-state/", import.meta.url));
  await Deno.mkdir(root, { recursive: true });
  cfg.harness.db = join(await Deno.makeTempDir({ dir: root }), "missing.db");
  const sessions: Session[] = ["case-a", "case-b"].map((id) => ({
    id,
    projectID: "project",
    directory: "/project",
    title: id,
    time: { created: 100, updated: 100 },
  }));
  const requests: {
    sessionID: string;
    signal: AbortSignal;
    release(response: Response): void;
  }[] = [];
  const ops: { sessionID: string; event: ContentOp }[] = [];
  const entries = new Map<string, IndexEntry>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let resets = 0;
  let holdGet = false;
  let releaseGet: (() => void) | undefined;
  let ignoreAbort = false;
  const fetcher: typeof fetch = (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === "/global/health") {
      return Promise.resolve(Response.json({ version: "1.18.34" }));
    }
    if (path === "/experimental/session") {
      return Promise.resolve(Response.json(sessions));
    }
    if (path === "/agent") {
      return Promise.resolve(
        Response.json([{ name: "build", mode: "primary" }]),
      );
    }
    if (path === "/global/event") {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                ),
              );
              options?.signal?.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch { /* Already closed for reconnect. */ }
              }, { once: true });
            },
          }),
        ),
      );
    }
    const match = path.match(
      /^\/session\/(case-[ab])(?:\/(shell|command|abort))?$/,
    );
    assert(match, `Unexpected native request: ${path}`);
    const session = sessions.find((session) => session.id === match[1])!;
    if (!match[2]) {
      if (holdGet) {
        holdGet = false;
        return new Promise<Response>((resolve) => {
          releaseGet = () => resolve(Response.json(session));
        });
      }
      return Promise.resolve(Response.json(session));
    }
    if (match[2] === "abort") return Promise.resolve(Response.json({}));
    const signal = options?.signal;
    assert(signal, "Owned HTTP operation has no lifecycle signal");
    return new Promise<Response>((resolve, reject) => {
      requests.push({ sessionID: session.id, signal, release: resolve });
      if (!ignoreAbort) {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      }
    });
  };
  const adapter = new Opencode1Adapter(cfg, new StreamBuffers(), fetcher);
  const wait = async (read: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!read()) {
      assert(
        Date.now() < deadline,
        `Normal error consumer stalled: ${JSON.stringify(ops)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await adapter.start({
    connection: () => {},
    indexReset: (values) => {
      resets++;
      entries.clear();
      for (const entry of values) entries.set(entry.id, structuredClone(entry));
    },
    indexUpsert: (entry) => entries.set(entry.id, structuredClone(entry)),
    indexRemove: (id) => entries.delete(id),
    content: (sessionID, event) =>
      ops.push({ sessionID, event: structuredClone(event) }),
    resync: () => {},
  });
  await wait(() => resets > 0);
  adapter.subscriptions("case-a", 1);
  adapter.subscriptions("case-b", 1);
  const send = (
    type: string,
    properties: Record<string, unknown>,
    id?: string,
  ) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            payload: { type, properties, ...(id ? { id } : {}) },
          })
        }\n\n`,
      ),
    );
  return {
    adapter,
    requests,
    ops,
    entries,
    wait,
    sessions,
    async submit(method: "shell" | "command", sessionID = "case-a") {
      const invoke = Reflect.get(adapter, method);
      assert(
        typeof invoke === "function",
        `Feature has no ${method} operation`,
      );
      await invoke.call(adapter, {
        sessionID,
        command: "owned operation",
        arguments: "",
      });
    },
    fail(index: number, message: string, ref = "http-reference") {
      requests[index].release(
        Response.json({ name: "UnknownError", data: { message, ref } }, {
          status: 503,
        }),
      );
    },
    native(
      message: string,
      sessionID = "case-a",
      eventID = "actual-native-event",
    ) {
      send("session.error", {
        sessionID,
        error: { name: "UnknownError", data: { message } },
      }, eventID);
    },
    busy(sessionID = "case-a") {
      send("session.status", { sessionID, status: { type: "busy" } });
    },
    remove(sessionID = "case-a") {
      send("session.deleted", {
        info: sessions.find((session) => session.id === sessionID),
      });
    },
    async reconnect() {
      const before = resets;
      stream.close();
      await wait(() => resets > before);
    },
    async dispose() {
      const before = resets;
      send("server.instance.disposed", {});
      await wait(() => resets > before);
    },
    holdQuery() {
      holdGet = true;
    },
    releaseQuery() {
      assert(releaseGet);
      releaseGet();
    },
    queryHeld() {
      return !!releaseGet;
    },
    allowLateResponse() {
      ignoreAbort = true;
    },
    async stop() {
      const stopped = adapter.stop();
      for (const request of requests) request.release(Response.json({}));
      releaseGet?.();
      await stopped;
    },
    async coherent(sessionID = "case-a") {
      const query = await adapter.getSession(sessionID);
      const state = observed(query);
      const index = entries.get(sessionID)!;
      assert(index);
      assertEquals(
        observed(index.attention),
        state,
        "Index and query disagree at an identified current state",
      );
      const current = ops.filter((item) =>
        item.sessionID === sessionID && item.event.op === "session.error"
      ).at(-1)?.event;
      assert(current);
      assertEquals(
        observed(current),
        state,
        "Content and query disagree at the same current state",
      );
      assertEquals(index.attention.error, query.error);
      assertEquals(Reflect.get(current, "error"), query.error);
      return { query, state };
    },
  };
}

export function errorObservationCases(method: "shell" | "command") {
  Deno.test(`${method} cancelling a local HTTP watcher cannot clear an independently observed native abort failure`, async () => {
    const f = await observationFixture();
    try {
      f.allowLateResponse();
      await f.submit(method);
      f.native("Aborted", "case-a", "native-abort-event");
      await f.wait(() =>
        f.ops.some((item) => Reflect.get(item.event, "error") === "Aborted")
      );
      await f.adapter.abort("case-a");
      assert(f.requests[0].signal.aborted);
      f.fail(0, "Cancelled HTTP watcher late failure");
      const current = await f.coherent();
      assertEquals(
        current.query.error,
        "Aborted",
        "Local watcher cancellation erased a genuine native failure",
      );
      assertEquals(current.state.observations.length, 1);
      assertEquals(current.state.observations[0].source, "event");
      assertEquals(current.state.observations[0].eventID, "native-abort-event");
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} native busy clears the current message while retaining independently observed HTTP provenance`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      f.fail(0, "HTTP diagnostic before native busy", "prior-http-ref");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") ===
            "HTTP diagnostic before native busy"
        )
      );
      f.busy();
      await f.wait(() =>
        f.ops.at(-1)?.event.op === "session.error" &&
        Reflect.get(f.ops.at(-1)!.event, "error") === undefined
      );
      const cleared = await f.coherent();
      assertEquals(cleared.query.error, undefined);
      assertEquals(cleared.state.observations.length, 1);
      assertEquals(
        cleared.state.observations[0].message,
        "HTTP diagnostic before native busy",
      );
      assertEquals(cleared.state.observations[0].cleared, true);
      f.native("Current native detail after busy");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") ===
            "Current native detail after busy"
        )
      );
      const detailed = await f.coherent();
      assertEquals(detailed.state.observations.length, 2);
      assertEquals(
        detailed.state.observations.find((item) => item.source === "http")?.ref,
        "prior-http-ref",
      );
      assertEquals(detailed.query.error, "Current native detail after busy");
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} HTTP-only failure remains visible with exact detail and actual provenance`, async () => {
    const f = await observationFixture();
    try {
      const message = "HTTP-only diagnostic " + "detail ".repeat(180);
      await f.submit(method);
      f.fail(0, message, "native-http-ref");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error")?.startsWith("HTTP-only diagnostic")
        )
      );
      const { query, state } = await f.coherent();
      assertEquals(
        query.error,
        message,
        "Available HTTP diagnostic detail was lost",
      );
      assertEquals(state.observations.length, 1);
      const observation = state.observations[0];
      assertEquals(observation.source, "http");
      assertEquals(observation.message, message);
      assertEquals(observation.kind, "UnknownError");
      assertEquals(observation.status, 503);
      assertEquals(observation.ref, "native-http-ref");
      assertEquals(observation.operation, method);
      assertEquals(observation.requestID, state.currentRequestID);
      assert(observation.requestID);
      assertEquals(observation.eventID, undefined);
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} event-only failure has native detail without invented request correlation`, async () => {
    const f = await observationFixture();
    try {
      f.native("Native-only detail");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") === "Native-only detail"
        )
      );
      const { state } = await f.coherent();
      assertEquals(state.observations.length, 1);
      assertEquals(state.observations[0].source, "event");
      assertEquals(state.observations[0].eventID, "actual-native-event");
      assertEquals(state.observations[0].requestID, undefined);
      assertEquals(f.requests.length, 0);
    } finally {
      await f.stop();
    }
  });
  for (const order of ["http-first", "event-first"] as const) {
    Deno.test(`${method} ${order} keeps distinct HTTP and native observations at one coherent revision`, async () => {
      const f = await observationFixture();
      try {
        await f.submit(method);
        if (order === "http-first") {
          f.fail(0, "HTTP coarse diagnostic");
          await f.wait(() =>
            f.ops.some((item) =>
              Reflect.get(item.event, "error") === "HTTP coarse diagnostic"
            )
          );
          f.native("Native useful detail");
        } else {
          f.native("Native useful detail");
          await f.wait(() =>
            f.ops.some((item) =>
              Reflect.get(item.event, "error") === "Native useful detail"
            )
          );
          f.fail(0, "HTTP coarse diagnostic");
        }
        await f.wait(() =>
          f.ops.some((item) => {
            const state = Reflect.get(item.event, "errorState");
            return state?.observations.length === 2;
          })
        );
        const { query, state } = await f.coherent();
        assertEquals(query.error, "Native useful detail");
        assertEquals(state.observations.map((item) => item.message).sort(), [
          "HTTP coarse diagnostic",
          "Native useful detail",
        ]);
        assertEquals(
          state.observations.find((item) => item.source === "event")?.requestID,
          undefined,
        );
        assertEquals(
          state.observations.find((item) => item.source === "http")?.requestID,
          state.currentRequestID,
        );
      } finally {
        await f.stop();
      }
    });
  }
  Deno.test(`${method} older owned HTTP settlement keeps provenance without replacing a newer failure`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      await f.submit(method);
      f.fail(1, "New request failure", "new-ref");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") === "New request failure"
        )
      );
      const first = await f.coherent();
      const frozen = structuredClone(first.state);
      f.fail(0, "Earlier request failure", "old-ref");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "errorState")?.observations.length === 2
        )
      );
      const next = await f.coherent();
      assertEquals(next.query.error, "New request failure");
      assert(next.state.revision > first.state.revision);
      assertEquals(
        first.state,
        frozen,
        "An established snapshot changed in place",
      );
      const old = next.state.observations.find((item) =>
        item.ref === "old-ref"
      )!;
      assert(old);
      assert(old.requestID !== next.state.currentRequestID);
      assertEquals(old.message, "Earlier request failure");
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} query reads current error ownership after native metadata completes`, async () => {
    const f = await observationFixture();
    try {
      f.holdQuery();
      const query = f.adapter.getSession("case-a");
      await f.wait(() => f.queryHeld());
      f.native("New observation during query");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") === "New observation during query"
        )
      );
      f.releaseQuery();
      const snapshot = await query;
      assertEquals(snapshot.error, "New observation during query");
      const current = await f.coherent();
      assertEquals(observed(snapshot), current.state);
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} busy clearing does not discard a genuine still-owned HTTP-only failure`, async () => {
    const f = await observationFixture();
    try {
      f.native("Prior native failure");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") === "Prior native failure"
        )
      );
      f.busy();
      await f.wait(() =>
        f.ops.at(-1)?.event.op === "session.error" &&
        Reflect.get(f.ops.at(-1)!.event, "error") === undefined
      );
      assertEquals((await f.coherent()).state.observations, []);
      await f.submit(method);
      f.busy();
      await f.wait(() =>
        f.ops.at(-1)?.event.op === "session.error" &&
        Reflect.get(f.ops.at(-1)!.event, "error") === undefined
      );
      f.fail(0, "Current HTTP failure after busy");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") === "Current HTTP failure after busy"
        )
      );
      assertEquals(
        (await f.coherent()).query.error,
        "Current HTTP failure after busy",
      );
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} cancellation and removal close only the actual session request lifetimes`, async () => {
    const f = await observationFixture();
    try {
      f.allowLateResponse();
      await f.submit(method, "case-a");
      await f.submit(method, "case-b");
      await f.adapter.abort("case-a");
      assert(
        f.requests[0].signal.aborted,
        "Cancellation left its HTTP watcher alive",
      );
      f.fail(0, "Cancelled late failure");
      f.fail(1, "Unrelated real failure");
      await f.wait(() =>
        f.ops.some((item) =>
          item.sessionID === "case-b" &&
          Reflect.get(item.event, "error") === "Unrelated real failure"
        )
      );
      assertEquals((await f.coherent("case-a")).state.observations, []);
      assertEquals(
        (await f.coherent("case-b")).query.error,
        "Unrelated real failure",
      );
      await f.submit(method, "case-a");
      f.remove();
      await f.wait(() => !f.entries.has("case-a"));
      assert(
        f.requests[2].signal.aborted,
        "Removed session left its HTTP watcher alive",
      );
      const before = f.ops.length;
      f.fail(2, "Removed late failure");
      f.native("Removed native late failure");
      f.native("Unrelated new native detail", "case-b", "other-event");
      await f.wait(() =>
        f.ops.some((item) =>
          item.sessionID === "case-b" &&
          Reflect.get(item.event, "error") === "Unrelated new native detail"
        )
      );
      assertEquals(
        f.ops.slice(before).filter((item) => item.sessionID === "case-a"),
        [],
      );
      assertEquals(
        (await f.coherent("case-b")).query.error,
        "Unrelated new native detail",
      );
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} same-instance reconnect preserves error observations in index and query`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      f.fail(0, "HTTP-only retained on reconnect");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") === "HTTP-only retained on reconnect"
        )
      );
      const first = await f.coherent();
      await f.reconnect();
      const next = await f.coherent();
      assertEquals(next.query.error, first.query.error);
      assertEquals(next.state, first.state);
    } finally {
      await f.stop();
    }
  });
  Deno.test(`${method} known instance disposal and stop cannot revive closed request errors`, async () => {
    const f = await observationFixture();
    try {
      f.allowLateResponse();
      await f.submit(method);
      await f.dispose();
      assert(
        f.requests[0].signal.aborted,
        "Disposed native instance left its old HTTP watcher alive",
      );
      const before = f.ops.length;
      f.fail(0, "Disposed instance late failure");
      f.native("Current instance native observation");
      await f.wait(() =>
        f.ops.some((item) =>
          Reflect.get(item.event, "error") ===
            "Current instance native observation"
        )
      );
      assertEquals(
        f.ops.slice(before).some((item) =>
          Reflect.get(item.event, "error") === "Disposed instance late failure"
        ),
        false,
      );
      await f.submit(method);
      const stopping = f.adapter.stop();
      const stopCount = f.ops.length;
      f.fail(1, "Stopped late failure");
      await stopping;
      assert(f.requests[1].signal.aborted);
      assertEquals(
        f.ops.length,
        stopCount,
        "Stopped owner published a late failure",
      );
    } finally {
      await f.stop();
    }
  });
}
