// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { IndexEntry, PublicFailure } from "@otk/protocol";
import {
  createFailurePresenter,
  notificationFailure,
  sessionFailure,
} from "../failure-features.ts";
import { NotificationTriggers } from "../notification-triggers.ts";
import type { Note } from "../notifications.ts";

const value: PublicFailure = {
  code: "native.rejected",
  retry: "new-intent",
  diagnosticID: "original",
  facts: {
    action: "session.prompt",
    reason: "Config path: opencode.config.ts",
    status: 400,
    outcome: "rejected",
    target: { sessionID: "opcv1-ses_one", label: "One" },
    record: {
      messageID: "record-one",
      label: "Not sent - see the error above",
    },
  },
};
Deno.test("FP1 scopes retained-record pointers to inline surfaces in the matching session view", () => {
  const presenter = createFailurePresenter();
  const feedback = presenter.describe(value);
  assertEquals(feedback.text, "Not sent - see the error above");
  assertEquals(feedback.failure?.reference?.messageID, "record-one");
  const full = presenter.describe(value, "record");
  assertEquals(full.failure?.reference, undefined);
  assertEquals(
    full.failure?.reason,
    "Config path: opencode.config.ts (HTTP 400)",
  );
  assertEquals(full.failure?.value.diagnosticID, "original");
  assertEquals(
    presenter.group(value).failure?.reference?.messageID,
    "record-one",
  );
  const produced = sessionFailure(
    {
      id: "event",
      source: "event",
      message: value.facts!.reason!,
      failure: value,
    },
    value.facts!.reason,
    {},
  );
  assert(produced);
  assertEquals(produced.facts?.record, value.facts?.record);
  for (const surface of ["session", "feedback"] as const) {
    assertEquals(
      presenter.describe(value, { surface, view: value.facts!.target }).text,
      surface === "session"
        ? "See the session error"
        : "Not sent - see the error above",
    );
    assertEquals(
      presenter.describe(value, { surface, view: value.facts!.target }).failure
        ?.reference?.messageID,
      "record-one",
    );
    for (
      const view of [undefined, { sessionID: "other" }, {
        ...value.facts!.target,
        sidecarId: "remote",
      }]
    ) {
      assertEquals(
        presenter.describe(value, { surface, view }).failure?.reference,
        undefined,
      );
    }
  }
  assertEquals(
    presenter.describe(value, {
      surface: "notification",
      view: value.facts!.target,
    }).failure?.reference,
    undefined,
  );
  assertEquals(
    presenter.describe({
      ...value,
      facts: { ...value.facts, record: undefined },
    }).failure?.reference,
    undefined,
  );
});

Deno.test("retained session failure reaches cross-session notification consumers", () => {
  const notes: Note[] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note),
    () => {},
  );
  const entry: IndexEntry = {
    id: "opcv1-ses_one",
    directory: "/project",
    title: "One",
    projectID: "p",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "busy",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  trigger.receive("local", { t: "index.snapshot", rev: 1, entries: [entry] });
  trigger.receive("local", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "upsert",
      entry: {
        ...entry,
        attention: {
          ...entry.attention,
          error: value.facts!.reason,
          errorState: {
            revision: 1,
            observations: [{
              id: "event",
              source: "event",
              message: value.facts!.reason!,
              failure: value,
            }],
          },
        },
      },
    }],
  });
  assertEquals(notes.length, 1);
  const shown = notificationFailure(notes[0]);
  assert(shown);
  assertEquals(shown.reference, undefined);
  assertEquals(shown.reason, "Config path: opencode.config.ts (HTTP 400)");
  assertEquals(shown.target.href, "#/local/opcv1-ses_one");
});
