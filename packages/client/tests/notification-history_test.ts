// SPDX-License-Identifier: LGPL-3.0-only
import { entitySnapshot, sessionEntity } from "./supervision-fixture.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { notificationFailure, NotificationTriggers } from "@otk/client";
import type { Note } from "../notifications.ts";
import type { Supervision } from "@otk/protocol";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

Deno.test("historical failure backfill and acknowledgement replay stay silent; a live failure alerts once with its cause", () => {
  const f = shellFixture(), notes: Note[] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note),
    () => {},
  );
  f.resources.observeEntries(
    "local",
    (change) => trigger.entriesChanged("local", change),
  );
  f.resources.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [shellEntry("root")],
  });
  f.resources.receive("local", {
    t: "inbox.snapshot",
    generation: "history",
    revision: 0,
    inbox: {
      projects: [],
      tasks: [],
      pathTemplates: [],
      seen: {},
      finishes: {},
    },
  });
  let revision = 0;
  const finish = (value: Supervision, admitted = false) =>
    f.resources.receive("local", {
      t: "inbox.patch",
      generation: "history",
      from: revision,
      revision: revision += 2,
      ...(admitted ? { admitted: true as const } : {}),
      ops: [{ op: "entity.upsert", value: sessionEntity("root", value) }, {
        op: "finish",
        sessionID: "root",
        time: value.terminal,
      }],
    });
  const failed = (terminal: number): Supervision => ({
    state: "finishedUnseen",
    terminal,
    unseen: true,
    outcome: "failed",
    terminalFailure: {
      code: "session.failure",
      retry: "none",
      diagnosticID: `quota/${terminal}`,
      facts: {
        reason: "The usage limit has been reached",
        recovery:
          "Check your provider quota or choose another available model, then send a new prompt.",
      },
    },
  });
  try {
    finish({ ...failed(10), terminalOrigin: "historical" });
    assertEquals(notes.length, 0);
    finish({ ...failed(20), terminalOrigin: "live" }, true);
    assertEquals(notes.length, 0);
    finish({
      ...failed(20),
      terminalOrigin: "live",
      unseen: false,
      state: "none",
    });
    finish({ ...failed(20), terminalOrigin: "live" });
    assertEquals(notes.length, 0);
    finish({ ...failed(30), terminalOrigin: "live" });
    assertEquals(notes.length, 1);
    finish({
      ...failed(30),
      terminalOrigin: "live",
      unseen: false,
      state: "none",
    });
    finish({ ...failed(30), terminalOrigin: "live" });
    assertEquals(notes.length, 1);
    const shown = notificationFailure(notes[0])!;
    assertEquals(shown.value.facts?.reason, "The usage limit has been reached");
    assertEquals(shown.value.facts?.target?.sessionID, "root");
    assertEquals(shown.value.facts?.actionLabel, "Running session");
    assertStringIncludes(shown.value.facts?.recovery ?? "", "provider quota");
    finish({ ...failed(30), terminalOrigin: "live" });
    assertEquals(notes.length, 1);
  } finally {
    trigger.stop();
    f.resources.stop();
  }
});

for (const outcome of ["succeeded", "failed"] as const) {
  Deno.test(`historical observation cannot consume a later live ${outcome} edge at the same terminal`, () => {
    const f = shellFixture(), notes: Note[] = [];
    const trigger = new NotificationTriggers(
      (note) => notes.push(note),
      () => {},
    );
    f.resources.observeEntries(
      "local",
      (change) => trigger.entriesChanged("local", change),
    );
    const entry = { ...shellEntry("root"), status: "idle" as const };
    f.resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [entry],
    });
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "late-event",
      revision: 0,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
      },
    });
    const failure = outcome === "failed"
      ? {
        code: "native.execution",
        retry: "none" as const,
        diagnosticID: "live-cause",
        facts: { reason: "Native execution refused" },
      }
      : undefined;
    const value = (terminalOrigin: "historical" | "live"): Supervision => ({
      state: "finishedUnseen",
      terminal: 10,
      outcome,
      unseen: true,
      terminalOrigin,
      ...(failure ? { terminalFailure: failure } : {}),
    });
    try {
      f.resources.receive("local", {
        t: "inbox.patch",
        generation: "late-event",
        from: 0,
        revision: 2,
        ops: [{ op: "finish", sessionID: "root", time: 10 }, {
          op: "entity.upsert",
          value: sessionEntity("root", value("historical")),
        }],
      });
      assertEquals(notes, []);
      f.resources.receive("local", {
        t: "inbox.patch",
        generation: "late-event",
        from: 2,
        revision: 3,
        ops: [{
          op: "entity.upsert",
          value: sessionEntity("root", value("live")),
        }],
      });
      if (outcome === "succeeded") {
        assertEquals(notes, []);
        f.resources.receive("local", {
          t: "inbox.settlement",
          generation: "late-event",
          revision: 1,
          values: [{
            sessionID: "root",
            value: { id: 10, unseen: true, live: true, outcome },
          }],
        });
      }
      assertEquals(notes.map((note) => note.kind), [
        outcome === "failed" ? "error" : "done",
      ]);
      f.resources.receive("local", {
        t: "index.patch",
        from: 0,
        rev: 1,
        ops: [{ op: "upsert", entry: { ...entry, activity: value("live") } }],
      });
      f.resources.receive("local", {
        t: "inbox.patch",
        generation: "late-event",
        from: 3,
        revision: 4,
        ops: [{
          op: "entity.upsert",
          value: sessionEntity("root", value("historical")),
        }],
      });
      assertEquals(notes.length, 1);
    } finally {
      trigger.stop();
      f.resources.stop();
    }
  });
}
Deno.test("authoritative settlement alone notifies across lagging terminal and replaced row views", () => {
  const f = shellFixture(), notes: Note[] = [], retracted: string[] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note),
    (id) => retracted.push(id),
  );
  f.resources.observeEntries(
    "local",
    (change) => trigger.entriesChanged("local", change),
  );
  const entry = { ...shellEntry("root"), activity: { terminal: 0 } };
  f.resources.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [entry],
  });
  f.resources.receive("local", {
    t: "inbox.snapshot",
    generation: "lagging",
    revision: 0,
    inbox: {
      projects: [],
      tasks: [],
      pathTemplates: [],
      seen: {},
      finishes: {},
      entities: entitySnapshot({
        supervision: { root: { state: "none", terminal: 0, unseen: false } },
      }),
    },
  });
  try {
    f.resources.receive("local", {
      t: "index.patch",
      from: 0,
      rev: 1,
      ops: [{
        op: "upsert",
        entry: {
          ...entry,
          activity: {
            terminal: 100,
            terminalOrigin: "live",
            outcome: "succeeded",
          },
        },
      }],
    });
    assertEquals(notes, []);
    const verdict = {
      id: 100,
      outcome: "succeeded" as const,
      unseen: true,
      live: true,
    };
    const publish = (revision: number, value: typeof verdict | null) =>
      f.resources.receive("local", {
        t: "inbox.settlement",
        generation: "lagging",
        revision,
        values: [{ sessionID: "root", value }],
      });
    publish(1, verdict);
    assertEquals(notes.map((note) => note.title), ["Session done"]);
    // View replacement may seed the same known terminal instead of delivering
    // the earlier view's live inbox patch. It must not erase or redeliver it.
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "lagging",
      revision: 2,
      inbox: {
        projects: [],
        tasks: [],
        pathTemplates: [],
        seen: {},
        finishes: { root: 100 },
        entities: entitySnapshot({
          supervision: {
            root: {
              state: "finishedUnseen",
              terminal: 100,
              unseen: true,
              terminalOrigin: "live",
              outcome: "succeeded",
            },
          },
        }),
      },
    });
    assertEquals(notes.length, 1);
    publish(2, null);
    assertEquals(retracted, ["local/root"]);
    publish(3, verdict);
    assertEquals(notes.length, 1);
  } finally {
    trigger.stop();
    f.resources.stop();
  }
});
