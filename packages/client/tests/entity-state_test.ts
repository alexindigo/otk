// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { entityKey, type EntityState } from "@otk/protocol";
import {
  attention,
  createEntityStateStore,
  emphasis,
  type EntityTransition,
  label,
  lamp,
  liveWork,
  sessionEvidence,
  sessionWorkStatus,
} from "../entity-state.ts";
import { createInbox } from "../inbox.ts";

const counts = { blocked: 0, working: 0, finished: 0, unseen: 0 };
const session = (
  state: EntityState["state"],
  extra: Partial<EntityState> = {},
  permissions: string[] = [],
): EntityState => ({
  kind: "session",
  id: "s",
  state,
  previous: "working",
  counts: { ...counts },
  evidence: {
    work: true,
    permissions: permissions.length,
    questions: 0,
    descendants: counts,
    requests: {
      permissions: permissions.map((id) => ({ id })),
      questions: [],
    },
  },
  ...extra,
});
const S = entityKey("session", "s");

Deno.test("session execution excludes shell-only activity and stale evidence", async () => {
  const { sessionRunning } = await import("../entity-state.ts") as Record<
    string,
    unknown
  >;
  const running = sessionRunning as (
    store: ReturnType<typeof createEntityStateStore>,
    id: string,
  ) => boolean;
  let value = session("working");
  const store = createEntityStateStore({ read: () => ({ [S]: value }) });
  assertEquals(running(store, S), true);
  value = {
    ...value,
    evidence: {
      ...value.evidence!,
      liveWork: [{
        id: "shell",
        kind: "shell",
        label: "Shell",
        title: "Shell",
        state: "working",
      }],
    },
  };
  assertEquals(running(store, S), false);
  value = session("working");
  store.stale(true);
  assertEquals(running(store, S), false);
});

Deno.test("evidence observers update without fabricating a lamp transition", () => {
  const f = fixture(), evidence: unknown[] = [], transitions: unknown[] = [];
  const stop = f.store.observeChanges((keys) => evidence.push(keys));
  f.store.subscribe((value) => transitions.push(value));
  try {
    f.put(session("blocked", { cause: "question" }));
    const count = transitions.length;
    f.put(
      session("blocked", {
        cause: "question",
        evidence: { ...sessionEvidence(f.store, S)!, work: false },
      }),
    );
    assertEquals(transitions.length, count);
    assertEquals(evidence.length, 2);
    assertEquals(sessionEvidence(f.store, S)?.work, false);
    f.store.stale(true);
    assertEquals(evidence.at(-1), "all");
    assertEquals(sessionEvidence(f.store, S), undefined);
    stop();
    const seen = evidence.length;
    f.store.stale(false);
    assertEquals(evidence.length, seen);
  } finally {
    f.store.stop();
  }
});

Deno.test("session row observations borrow work and retry evidence independently of lamp priority", () => {
  const f = fixture();
  try {
    assertEquals(sessionWorkStatus(f.store, S), undefined);
    f.put(session("blocked", { cause: "question" }));
    assertEquals(sessionWorkStatus(f.store, S), "busy");
    const evidence: NonNullable<ReturnType<typeof sessionEvidence>> = {
      ...sessionEvidence(f.store, S)!,
      work: false,
      retry: { attempt: 2 },
    };
    f.put(session("working", { evidence }));
    assertEquals(sessionWorkStatus(f.store, S), "retry");
    delete evidence.retry;
    f.put(session("none", { evidence }));
    assertEquals(sessionWorkStatus(f.store, S), "idle");
    f.store.stale(true);
    assertEquals(sessionWorkStatus(f.store, S), undefined);
  } finally {
    f.store.stop();
  }
});

function fixture() {
  const values: Record<string, EntityState> = {};
  const store = createEntityStateStore({
    read: () => values,
  });
  const transitions: EntityTransition[] = [];
  store.subscribe((t) => transitions.push(t));
  const put = (
    value: EntityState,
    origin: EntityTransition["origin"] = "live",
  ) => {
    values[entityKey(value.kind, value.id)] = value;
    store.observe([entityKey(value.kind, value.id)], origin);
  };
  const remove = (key: string) => {
    delete values[key];
    store.observe([key], "live");
  };
  return { values, store, transitions, put, remove };
}

Deno.test("questions, forms, operations and failed helpers are immediate", () => {
  const f = fixture();
  for (
    const cause of ["question", "form", "operation", "failedHelper"] as const
  ) {
    f.put(session("blocked", { cause }, ["p"]));
    assertEquals(lamp(f.store, S), "blocked", cause);
  }
  f.store.stop();
});

Deno.test("absent and stale entities read as none (D6)", () => {
  const f = fixture();
  assertEquals(lamp(f.store, S), "none");
  f.put(session("working"));
  f.store.stale(true);
  assertEquals(lamp(f.store, S), "none");
  assertEquals(liveWork(f.store, S), undefined);
  f.store.stale(false);
  assertEquals(lamp(f.store, S), "working");
  f.store.stop();
});

Deno.test("transitions carry their origin; a replaced baseline is historical", () => {
  const f = fixture();
  f.put(session("working"), "historical");
  f.put(session("finished"));
  f.remove(S);
  assertEquals(
    f.transitions.map((t) => [t.from, t.to, t.origin]),
    [
      ["none", "working", "historical"],
      ["working", "finished", "live"],
      ["finished", "none", "live"],
    ],
  );
  f.put(session("working"), "unknown");
  assertEquals(f.transitions.at(-1)?.origin, "unknown");
  f.store.stop();
});

Deno.test("emphasis, attention counts, labels and live work borrow the same state", () => {
  const f = fixture();
  f.put({
    kind: "global",
    id: "global",
    state: "working",
    previous: "none",
    counts: { blocked: 2, working: 3, finished: 1, unseen: 4 },
  });
  const G = entityKey("global", "global");
  assertEquals(attention(f.store, G), { blocked: 2, finished: 1 });
  assertEquals(emphasis(f.store, G), true);
  assertEquals(label("working"), "Working");
  assertEquals(label("blocked", "permission"), "Needs you");
  const item = {
    id: "shell-1",
    kind: "shell" as const,
    label: "Shell",
    title: "sleep",
    state: "working" as const,
  };
  f.put(session("working", {
    evidence: {
      work: true,
      permissions: 0,
      questions: 0,
      descendants: counts,
      liveWork: [item],
    },
  }));
  assertEquals(liveWork(f.store, S), [item]);
  f.store.stop();
});

Deno.test("the inbox replica feeds the store: baselines are historical, admitted rows too", () => {
  const model = createInbox(
    { call: () => Promise.reject(new Error("unused")) },
    undefined,
    undefined,
    undefined,
  );
  const transitions: EntityTransition[] = [];
  model.entities.subscribe((t) => transitions.push(t));
  const working = session("working");
  model.receive({
    t: "inbox.snapshot",
    generation: "g",
    revision: 0,
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
      entities: { [S]: working },
    },
  });
  model.receive({
    t: "inbox.patch",
    generation: "g",
    from: 0,
    revision: 1,
    ops: [{ op: "entity.upsert", value: session("finished") }],
  });
  model.receive({
    t: "inbox.patch",
    generation: "g",
    from: 1,
    revision: 2,
    admitted: true,
    ops: [{
      op: "entity.upsert",
      value: { ...session("working"), id: "other" },
    }],
  });
  assertEquals(
    transitions.map((t) => [t.key, t.to, t.origin]),
    [
      [S, "working", "historical"],
      [S, "finished", "live"],
      [entityKey("session", "other"), "working", "historical"],
    ],
  );
  assertEquals(model.entities.get(S)?.state, "finished");

  model.stop();
});
