// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { IndexEntry, PublicFailure } from "@otk/protocol";
import {
  composerPointer,
  createFailurePresenter,
  notificationFailure,
  sessionComposerFeedback,
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
    origin: "composer",
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
const hasRecord = (id: string) => id === "record-one" || id === "record-two";
Deno.test("retained composer feedback is a displayed current target projection, never a phantom or replacement for local feedback", () => {
  const view = { sidecarId: "server", sessionID: "opcv1-ses_one" };
  const observation = {
    id: "other-client",
    source: "event" as const,
    message: "Rejected input",
    failure: value,
  };
  const state = { revision: 1, observations: [observation] };
  const shown = sessionComposerFeedback(state, view, undefined, hasRecord);
  assertEquals(shown?.failure?.reference?.messageID, "record-one");
  assertEquals(shown?.failure?.value.facts?.target?.sidecarId, "server");
  const local = { kind: "pending" as const, text: "Current local action" };
  assert(sessionComposerFeedback(state, view, local, hasRecord) === local);
  assertEquals(
    sessionComposerFeedback(
      {
        revision: 2,
        observations: [{ ...observation, cleared: true }],
      },
      view,
      undefined,
      hasRecord,
    ),
    undefined,
  );
  assertEquals(
    sessionComposerFeedback(
      state,
      { ...view, sessionID: "other" },
      undefined,
      hasRecord,
    ),
    undefined,
  );
  assertEquals(
    sessionComposerFeedback(
      {
        revision: 1,
        observations: [{
          ...observation,
          failure: {
            ...value,
            facts: {
              ...value.facts,
              target: { ...value.facts!.target, sidecarId: "foreign" },
            },
          },
        }],
      },
      view,
      undefined,
      hasRecord,
    ),
    undefined,
  );
});
Deno.test("FP1 scopes retained-record pointers to inline surfaces in the matching session view", () => {
  const presenter = createFailurePresenter();
  const feedback = presenter.describe(value, {
    surface: "feedback",
    view: value.facts!.target,
    hasRecord,
  });
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
    undefined,
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
      presenter.describe(value, {
        surface,
        view: value.facts!.target,
        hasRecord,
      }).text,
      surface === "session"
        ? "See the session error"
        : "Not sent - see the error above",
    );
    assertEquals(
      presenter.describe(value, {
        surface,
        view: value.facts!.target,
        hasRecord,
      }).failure
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
        presenter.describe(value, { surface, view, hasRecord }).failure
          ?.reference,
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

Deno.test("FP1 gives each retained failure one inline pointer at its origin", () => {
  const presenter = createFailurePresenter();
  for (
    const origin of [
      undefined,
      "composer",
      "session",
      "palette",
      "api",
    ] as const
  ) {
    const failure = { ...value, facts: { ...value.facts, origin } };
    const view = failure.facts.target;
    const composer = presenter.place(failure, {
      surface: "feedback",
      view,
      hasRecord,
    });
    const session = presenter.place(failure, {
      surface: "session",
      view,
      hasRecord,
    });
    assertEquals(
      composer?.text,
      origin === "composer" ? "Not sent - see the error above" : undefined,
    );
    assertEquals(
      session?.text,
      origin !== "composer" ? "See the session error" : undefined,
    );
    assertEquals(
      presenter.place(failure, "record")?.failure?.reference,
      undefined,
    );
    assertEquals(
      presenter.place(failure, { surface: "notification", view })
        ?.failure?.reason,
      "Config path: opencode.config.ts (HTTP 400)",
    );
    for (const surface of ["feedback", "session"] as const) {
      assert(
        presenter.place(failure, { surface, view: { sessionID: "other" } }),
      );
    }
  }
});

Deno.test("FP1 spends a view's one pointer on the composer before the session indicator", () => {
  const presenter = createFailurePresenter();
  const view = value.facts!.target!;
  const feedback = { surface: "feedback", view, hasRecord } as const;
  const session = { surface: "session", view, hasRecord } as const;
  // Two independent failures in one session view: the composer submission's
  // HTTP failure and an unlinked native report with no origin.
  const submitted = value;
  const native: PublicFailure = {
    ...value,
    diagnosticID: "native",
    code: "native.execution",
    facts: {
      ...value.facts,
      origin: undefined,
      record: { messageID: "record-two" },
    },
  };
  const composer = presenter.place(submitted, feedback);
  assertEquals(composer?.text, "Not sent - see the error above");
  const pointers = [
    composer,
    presenter.place(native, feedback),
    presenter.place(submitted, session, composer),
    presenter.place(native, session, composer),
  ].filter(Boolean);
  assertEquals(pointers.map((p) => p?.failure?.reference?.messageID), [
    "record-one",
  ]);
  // Both records stay complete; only their inline pointers are budgeted.
  for (const failure of [submitted, native]) {
    assertEquals(
      presenter.place(failure, "record")?.failure?.value.diagnosticID,
      failure.diagnosticID,
    );
  }
  // With no composer pointer in this view, the session indicator appears.
  assertEquals(
    presenter.place(native, session)?.text,
    "See the session error",
  );
  // A composer submission retained in the session's failures holds the
  // budget in every view of it, even when another client submitted it.
  const retained = composerPointer(
    [native, submitted],
    view,
    undefined,
    hasRecord,
  );
  assertEquals(retained?.failure?.reference?.messageID, "record-one");
  assertEquals(
    presenter.place(native, session, retained),
    undefined,
  );
  assertEquals(
    composerPointer([native], view, undefined, hasRecord),
    undefined,
  );
  assertEquals(
    composerPointer([submitted], { sessionID: "other" }, undefined, hasRecord),
    undefined,
  );
  // A composer pointer in another view does not spend this view's budget.
  assertEquals(
    presenter.place(
      native,
      session,
      presenter.place({
        ...submitted,
        facts: {
          ...submitted.facts,
          target: { sessionID: "opcv1-ses_two" },
        },
      }, { ...feedback, view: { sessionID: "opcv1-ses_two" } }),
    )?.text,
    "See the session error",
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
