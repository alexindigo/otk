// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  aggregateTransition,
  inputTransition,
  sessionTransition,
  type SessionTransitionFacts,
} from "@otk/protocol";

const idle: SessionTransitionFacts = {
  deleted: false,
  archived: false,
  fresh: true,
  helper: true,
  opened: false,
  questions: 0,
  permissions: 0,
  work: false,
  terminal: 0,
  unseen: false,
};

Deno.test("attention rule IDs describe the same lamp, cause and roster winner", () => {
  const cases = [
    [
      { deleted: true, work: true, unseen: true },
      "session.retired",
      "none",
      undefined,
      undefined,
    ],
    [
      { questions: 1, permissions: 1, work: true },
      "session.question",
      "blocked",
      "question",
      "needsYou",
    ],
    [
      { operation: "blocked", permissions: 1 },
      "session.operation-blocked",
      "blocked",
      "operation",
      "needsYou",
    ],
    [
      { outcome: "failed", unseen: true, work: true },
      "session.unseen-failure",
      "blocked",
      "failedHelper",
      "needsYou",
    ],
    [
      { permissions: 1, work: true },
      "session.permission",
      "blocked",
      "permission",
      "needsYou",
    ],
    [
      { work: true, unseen: true },
      "session.work",
      "working",
      undefined,
      "running",
    ],
    [
      { unseen: true },
      "session.unseen-finish",
      "finished",
      undefined,
      "finished",
    ],
    [
      { opened: true, outcome: "failed" },
      "session.retained-open",
      "none",
      undefined,
      "opened",
    ],
    [
      { outcome: "failed" },
      "session.no-evidence",
      "none",
      undefined,
      undefined,
    ],
  ] as const;
  for (const [input, ...expected] of cases) {
    const { rule, status, cause, helper } = sessionTransition({
      ...idle,
      ...input,
    });
    assertEquals([rule, status, cause, helper], [...expected]);
  }
});

Deno.test("only matching, current, quiescent terminal evidence settles a session", () => {
  const ended = {
    ...idle,
    terminal: 12,
    outcome: "succeeded",
    unseen: true,
    confirmed: 12,
  } as const;
  assertEquals(sessionTransition(ended).settlement, {
    id: 12,
    outcome: "succeeded",
    live: true,
    unseen: true,
  });
  for (
    const input of [
      { fresh: false },
      { confirmed: 11 },
      { archived: true },
      { deleted: true },
      { questions: 1 },
      { work: true },
    ]
  ) {
    assertEquals(
      sessionTransition({ ...ended, ...input }).settlement,
      undefined,
    );
  }
});

Deno.test("aggregate priority does not hide positive work or turn a form into a session", () => {
  const facts = {
    forms: 1,
    dependencies: 1,
    graced: 0,
    counts: { blocked: 0, working: 1, finished: 1, unseen: 1 },
  };
  assertEquals(aggregateTransition(facts), {
    rule: "aggregate.form",
    state: "blocked",
    cause: "form",
    liveWork: true,
  });
  const noForm = { ...facts, forms: 0 };
  assertEquals(aggregateTransition(noForm).rule, "aggregate.finished");
  assertEquals(
    aggregateTransition({ ...noForm, counts: { ...facts.counts, finished: 0 } })
      .rule,
    "aggregate.working",
  );
  const idle = { ...noForm, counts: { ...facts.counts, working: 0 } };
  assertEquals(aggregateTransition(idle).rule, "aggregate.finished");
  const seen = { ...idle, counts: { ...idle.counts, finished: 0, unseen: 0 } };
  assertEquals(aggregateTransition(seen).rule, "aggregate.dependencies");
  assertEquals(
    aggregateTransition({ ...seen, dependencies: 0 }).rule,
    "aggregate.none",
  );
  assertEquals(
    aggregateTransition({ ...seen, operation: "blocked" }).rule,
    "aggregate.operation",
  );
  assertEquals(
    aggregateTransition({
      ...seen,
      graced: 1,
      counts: { ...seen.counts, blocked: 1 },
    }).rule,
    "aggregate.permission",
  );
});

Deno.test("native input dismissal preserves authority and terminal IDs reject replay", () => {
  const admitted = inputTransition(undefined, { type: "observe" });
  assertEquals(admitted, {
    rule: "input.admit",
    phase: { state: "pending", dismissed: false },
  });
  const hidden = inputTransition(admitted.phase, { type: "dismiss" });
  assertEquals(hidden, {
    rule: "input.dismiss",
    phase: { state: "pending", dismissed: true },
  });
  assertEquals(inputTransition(hidden.phase, { type: "observe" }), {
    rule: "input.refresh",
    phase: hidden.phase,
  });
  assertEquals(inputTransition(hidden.phase, { type: "show" }), {
    rule: "input.show",
    phase: admitted.phase,
  });
  assertEquals(inputTransition(hidden.phase, { type: "dismiss" }), {
    rule: "input.presentation-replay",
  });
  for (
    const state of ["settled-locally", "settled-remotely", "retired"] as const
  ) {
    const ended = inputTransition(hidden.phase, { type: "settle", state });
    assertEquals(ended, {
      rule: `input.${state}`,
      phase: { state, dismissed: true },
    });
    assertEquals(inputTransition(ended.phase, { type: "observe" }), {
      rule: "input.terminal-replay",
    });
  }
});
