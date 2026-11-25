// SPDX-License-Identifier: LGPL-3.0-only
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
      ops: [{ op: "supervision", sessionID: "root", value }, {
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

Deno.test("live native terminal advances independently of a lagging or replaced inbox view", () => {
  const f = shellFixture(), notes: Note[] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note),
    () => {},
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
      supervision: { root: { state: "none", terminal: 0, unseen: false } },
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
        supervision: {
          root: {
            state: "finishedUnseen",
            terminal: 100,
            unseen: true,
            terminalOrigin: "live",
            outcome: "succeeded",
          },
        },
      },
    });
    assertEquals(notes.length, 1);
  } finally {
    trigger.stop();
    f.resources.stop();
  }
});
