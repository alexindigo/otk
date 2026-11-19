// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  createSidecars,
  failureNote,
  failureValue,
  type Note,
  notificationFailure,
  NotificationTriggers,
  RequestFailure,
  RequestTracker,
  Rpc,
} from "@otk/client";
import { latestTerminal, type SupervisionEvidence } from "@otk/protocol";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

Deno.test("failed completion and failure facts merge into one session-outcome note in either arrival order", () => {
  for (const factsFirst of [true, false]) {
    const notes = new Map<string, Note>();
    const trigger = new NotificationTriggers(
      (note) => notes.set(note.id, note),
      (id) => notes.delete(id),
    );
    const entry = shellEntry("tstv1-one-failure");
    trigger.receive("remote", {
      t: "index.snapshot",
      rev: 1,
      entries: [{ ...entry, status: "busy" }],
    });
    const error = { error: "Agent not found: missing-agent" };
    const terminal = { terminal: 20, outcome: "failed" as const };
    trigger.receive("remote", {
      t: "index.patch",
      rev: 2,
      ops: [{
        op: "upsert",
        entry: {
          ...entry,
          status: factsFirst ? "busy" : "idle",
          attention: { ...entry.attention, ...(factsFirst ? error : {}) },
          ...(factsFirst ? {} : { activity: terminal }),
        },
      }],
    });
    if (factsFirst) {
      trigger.receive("remote", {
        t: "index.patch",
        rev: 3,
        ops: [{
          op: "upsert",
          entry: {
            ...entry,
            status: "busy",
            title: "Enriched title",
            attention: { ...entry.attention, ...error },
          },
        }],
      });
      assertEquals(notes.size, 1);
    }
    trigger.receive("remote", {
      t: "index.patch",
      rev: factsFirst ? 4 : 3,
      ops: [{
        op: "upsert",
        entry: {
          ...entry,
          status: "idle",
          attention: { ...entry.attention, ...error },
          activity: terminal,
        },
      }],
    });
    assertEquals(notes.size, 1);
    const note = [...notes.values()][0];
    assertEquals(notificationFailure(note)?.value.facts?.reason, error.error);
    assertEquals(note.actions[0].label, "Open session");
    assertEquals(note.sessionRef, { sidecar: "remote", session: entry.id });
  }
});

Deno.test("failed outcome coalescing never consumes independent input attention", async () => {
  const notes = new Map<string, Note>();
  const trigger = new NotificationTriggers(
    (note) => notes.set(note.id, note),
    (id) => notes.delete(id),
  );
  const entry = shellEntry("tstv1-failure-with-input");
  trigger.receive("remote", { t: "index.snapshot", rev: 1, entries: [entry] });
  trigger.receive("remote", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "upsert",
      entry: {
        ...entry,
        attention: {
          ...entry.attention,
          permissions: 1,
          error: "Provider limit",
        },
        activity: { terminal: 20, outcome: "failed" },
      },
    }],
  });
  assertEquals([...notes.values()].map((note) => note.kind), ["error"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assertEquals([...notes.values()].map((note) => note.kind).sort(), [
    "error",
    "permission",
  ]);
  trigger.receive("remote", {
    t: "index.patch",
    rev: 3,
    ops: [{
      op: "upsert",
      entry: {
        ...entry,
        attention: { ...entry.attention, error: "Provider limit" },
        activity: { terminal: 20, outcome: "failed" },
      },
    }],
  });
  assertEquals(notes.size, 1);
  assertEquals(
    notificationFailure([...notes.values()][0])?.value.facts?.reason,
    "Provider limit",
  );
  trigger.reset("remote");
  assertEquals(notes.size, 0);
});

Deno.test("every connection borrows the same sidecar-keyed title source", () => {
  const collection = createSidecars(() => {}, {
    storage: {
      getItem: () =>
        JSON.stringify([{
          id: "remote",
          baseUrl: "https://remote.test",
          label: "Remote",
        }]),
      setItem() {},
    },
    sessionTitle: (sidecar, id) => `${sidecar}/${id}`,
  });
  try {
    for (const sidecar of ["local", "remote"]) {
      const tracker = collection.connection(sidecar).rpc.requests;
      assertEquals(
        tracker.failureFacts("session.rename", { sessionID: "tstv1-target" })
          .target?.label,
        `${sidecar}/tstv1-target`,
      );
    }
  } finally {
    collection.stop();
  }
});

Deno.test("request failures capture the canonical title before selection or metadata changes", async () => {
  let title = "Original target";
  const tracker = new RequestTracker({
    send() {},
    sidecarId: "remote",
    sessionTitle: (id) => id === "tstv1-native_id" ? title : undefined,
  });
  const rpc = new Rpc(() => {}, tracker);
  tracker.connect(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 },
    16,
  );
  try {
    const op = rpc.start("session.rename", {
      sessionID: "tstv1-native_id",
      title: "Desired title",
    });
    const result = op.result.catch((cause: unknown) => cause);
    title = "Different current target";
    tracker.receive({
      t: "request.rejected",
      ref: op.state.ref,
      error: {
        code: "session.missing",
        retry: "none",
        diagnosticID: "review-title",
      },
    });
    const cause = await result;
    assert(cause instanceof RequestFailure);
    const owner = createFailurePresenter();
    assertEquals(owner.present(cause.failure).failure?.target, {
      label: "Original target",
      href: "#/remote/tstv1-native_id",
    });
    assertEquals(
      owner.present({
        ...cause.failure,
        facts: {
          action: "session.rename",
          target: { sidecarId: "remote", sessionID: "tstv1-native_id" },
        },
      }).failure?.target,
      { label: "native_id", href: "#/remote/tstv1-native_id" },
    );
  } finally {
    tracker.stop();
  }
});

Deno.test("terminal merging keeps outcome paired to its timestamp, including late outcome evidence", () => {
  const old: SupervisionEvidence = { terminal: 10, outcome: "succeeded" };
  assertEquals(latestTerminal(old, { terminal: 20 }), {
    terminal: 20,
    outcome: undefined,
  });
  assertEquals(latestTerminal({ terminal: 20 }, old), {
    terminal: 20,
    outcome: undefined,
  });
  assertEquals(
    latestTerminal({ terminal: 20 }, { terminal: 20, outcome: "failed" }),
    { terminal: 20, outcome: "failed" },
  );
  assertEquals(
    latestTerminal({ terminal: 20, outcome: "failed" }, { terminal: 20 }),
    { terminal: 20, outcome: "failed" },
  );
});

Deno.test("inline and notification context cannot replace a captured target title", () => {
  const cause = new RequestFailure({
    code: "fixture.title",
    retry: "none",
    diagnosticID: "retained-title",
    facts: {
      action: "session.rename",
      target: {
        sidecarId: "remote",
        sessionID: "tstv1-native_id",
        label: "Captured target",
      },
    },
  });
  for (const label of [undefined, "Different current target"]) {
    const context = {
      target: { sidecarId: "remote", sessionID: "tstv1-native_id", label },
    };
    const inline = failureValue(cause, context);
    assert(inline);
    assertEquals(inline.failure?.target.label, "Captured target");
    const note = failureNote(cause, context)!;
    assertEquals(notificationFailure(note)?.target, {
      label: "Captured target",
      href: "#/remote/tstv1-native_id",
    });
  }
});

Deno.test("terminal replacement clears an older outcome when composed with retained activity", () => {
  const old: SupervisionEvidence = { terminal: 10, outcome: "succeeded" };
  const current: SupervisionEvidence = { terminal: 20 };
  const merged = { ...current, ...old, ...latestTerminal(current, old) };
  assertEquals(merged.terminal, 20);
  assertEquals(merged.outcome, undefined);
});

Deno.test("supervision's paired outcome reaches finish notifications before index activity", () => {
  const f = shellFixture(), notes: Note[] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note),
    () => {},
  );
  f.resources.observeEntries(
    "local",
    (change) => trigger.entriesChanged("local", change),
  );
  try {
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [shellEntry("root")],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "review",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    f.resources.receive("local", {
      t: "inbox.patch",
      generation: "review",
      from: 0,
      revision: 2,
      ops: [
        {
          op: "supervision",
          sessionID: "root",
          value: { state: "finishedUnseen", terminal: 20, outcome: "failed" },
        },
        { op: "finish", sessionID: "root", time: 20 },
      ],
    });
    assertEquals(notes.map((note) => [note.title, note.kind]), [[
      "Session failed",
      "error",
    ]]);
  } finally {
    f.resources.stop();
  }
});

Deno.test("finish notifications use terminal outcome before separate error observations arrive", () => {
  for (
    const outcome of ["failed", "succeeded", "interrupted", undefined] as const
  ) {
    const notes: Note[] = [], retracted: string[] = [];
    const trigger = new NotificationTriggers(
      (note) => notes.push(note),
      (id) => retracted.push(id),
    );
    const entry = shellEntry("tstv1-review");
    trigger.receive("remote", {
      t: "index.snapshot",
      rev: 1,
      entries: [{ ...entry, status: "busy" }],
    });
    trigger.receive("remote", {
      t: "index.patch",
      rev: 2,
      ops: [{
        op: "upsert",
        entry: {
          ...entry,
          status: "idle",
          activity: { terminal: 20, ...(outcome ? { outcome } : {}) },
        },
      }],
    });
    assertEquals(notes.map((note) => [note.title, note.kind]), [
      outcome === "failed"
        ? ["Session failed", "error"]
        : outcome === "succeeded"
        ? ["Session done", "done"]
        : outcome === "interrupted"
        ? ["Session interrupted", "info"]
        : ["Session finished (outcome unknown)", "info"],
    ]);
    if (!outcome) {
      trigger.receive("remote", {
        t: "index.patch",
        rev: 3,
        ops: [{
          op: "upsert",
          entry: {
            ...entry,
            status: "idle",
            activity: { terminal: 20, outcome: "failed" },
          },
        }],
      });
      assertEquals(notes.at(-1)?.title, "Session failed");
      assertEquals(notes.at(-1)?.id, "remote/tstv1-review/outcome/failed");
      assertEquals(retracted, [notes[0].id]);
    }
  }
});
