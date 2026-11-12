// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import { LIGHT_STATES, sessionLight } from "../components/status-light.ts";
Deno.test("session lights render the supervision projection and default to No known activity", () => {
  const entry: IndexEntry = {
    id: "session",
    directory: "/project",
    projectID: "project",
    title: "Session",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  assertEquals(sessionLight(entry), "none");
  for (const status of ["busy", "retry"] as const) {
    entry.status = status;
    assertEquals(sessionLight(entry), "none");
    for (
      const field of [
        "permissions",
        "questions",
        "childPermissions",
        "childQuestions",
      ] as const
    ) {
      entry.attention[field] = 1;
      assertEquals(sessionLight(entry), "none");
      entry.attention[field] = 0;
    }
    entry.attention.error = "error";
    assertEquals(sessionLight(entry), "none");
    delete entry.attention.error;
  }
  for (
    const [state, expected] of [
      ["working", "working"],
      ["needsYou", "blocked"],
      ["finishedUnseen", "finished"],
      ["none", "none"],
    ] as const
  ) {
    assertEquals(
      sessionLight(entry, {
        seen: {},
        finishes: {},
        supervision: { [entry.id]: { state, terminal: 10 } },
      }),
      expected,
    );
  }
  assertEquals(LIGHT_STATES.none.label, "No known activity");
  assertEquals(Object.values(LIGHT_STATES).map((state) => state.shape), [
    "×",
    "◐",
    "✓",
    "○",
  ]);
});
