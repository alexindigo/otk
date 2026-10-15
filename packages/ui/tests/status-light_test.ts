// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import { LIGHT_STATES, sessionLight } from "../components/status-light.ts";
Deno.test("session lights prioritise family attention over working and preserve idle without inventing seen marks", () => {
  const entry: IndexEntry = {
    id: "session",
    directory: "/project",
    projectID: "project",
    title: "Session",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  assertEquals(sessionLight(entry), "idle");
  for (const status of ["busy", "retry"] as const) {
    entry.status = status;
    assertEquals(sessionLight(entry), "working");
    for (
      const field of [
        "permissions",
        "questions",
        "childPermissions",
        "childQuestions",
      ] as const
    ) {
      entry.attention[field] = 1;
      assertEquals(sessionLight(entry), "blocked");
      entry.attention[field] = 0;
    }
    entry.attention.error = "error";
    assertEquals(sessionLight(entry), "blocked");
    delete entry.attention.error;
  }
  assertEquals(Object.values(LIGHT_STATES).map((state) => state.shape), [
    "×",
    "◐",
    "✓",
    "○",
  ]);
});
