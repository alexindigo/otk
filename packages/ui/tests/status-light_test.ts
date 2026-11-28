// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import { createEntityStateStore } from "@otk/client";
import {
  LIGHT_STATES,
  lightDescription,
  sessionLight,
} from "../components/status-light.ts";
Deno.test("shared dependency descriptions show the projected count without replacing higher states", () => {
  assertEquals(lightDescription("dependencies", 1), "Running in terminal (1)");
  assertEquals(lightDescription("dependencies", 3), "Running in terminal (3)");
  assertEquals(lightDescription("working", 3), "Working");
  assertEquals(lightDescription("none", 0), "No known activity");
});
Deno.test("session lights render entity states and default to No known activity", () => {
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
      ["blocked", "blocked"],
      ["finished", "finished"],
      ["none", "none"],
    ] as const
  ) {
    const entities = createEntityStateStore({
      read: () => ({
        ["session:" + entry.id]: {
          kind: "session",
          id: entry.id,
          state,
          previous: state,
          counts: { blocked: 0, working: 0, finished: 0, unseen: 0 },
        },
      }),
    });
    try {
      assertEquals(sessionLight(entry, entities), expected);
      entities.stale(true);
      assertEquals(sessionLight(entry, entities), "none");
    } finally {
      entities.stop();
    }
  }
  assertEquals(LIGHT_STATES.none.label, "No known activity");
  assertEquals(Object.values(LIGHT_STATES).map((state) => state.shape), [
    "cross",
    "half-disc",
    "check",
    "diamond",
    "circle",
  ]);
  const entities = createEntityStateStore({
    read: () => ({
      [`session:${entry.id}`]: {
        kind: "session",
        id: entry.id,
        state: "none",
        previous: "none",
        dependencies: 2,
        counts: { blocked: 0, working: 0, finished: 0, unseen: 0 },
      },
    }),
  });
  assertEquals(sessionLight(entry, entities), "none");
  entities.stop();
});
