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
