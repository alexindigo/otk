// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  entityKey,
  type EntityKind,
  type EntityState,
  type InboxOp,
  type InboxSnapshot,
} from "../mod.ts";

const counts = { blocked: 1, working: 0, finished: 0, unseen: 0 };

Deno.test("entity keys preserve kind and opaque identity without path normalization", () => {
  const kinds: EntityKind[] = [
    "session",
    "task",
    "checkout",
    "project",
    "archive",
    "global",
  ];
  assertEquals(
    new Set(kinds.map((kind) => entityKey(kind, "same:id"))).size,
    kinds.length,
  );
  assertEquals(
    entityKey("checkout", "/repo/worktree"),
    "checkout:/repo/worktree",
  );
  assertNotEquals(
    entityKey("project", "/repo"),
    entityKey("checkout", "/repo"),
  );
});

Deno.test("entity state inbox contract retains request identity evidence without requiring client clocks on the server", () => {
  const entity: EntityState = {
    kind: "session",
    id: "s",
    state: "blocked",
    cause: "permission",
    previous: "working",
    counts,
    evidence: {
      work: true,
      permissions: 2,
      questions: 1,
      descendants: { ...counts, blocked: 0 },
      requests: {
        permissions: [{ id: "survives", arrivedAt: 0 }, {
          id: "replacement",
          arrivedAt: 300,
        }],
        questions: [{ id: "question" }],
      },
    },
  };
  const key = entityKey(entity.kind, entity.id);
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    entities: { [key]: entity },
  };
  const ops: InboxOp[] = [{ op: "entity.upsert", value: entity }, {
    op: "entity.remove",
    key,
  }];
  assertEquals(JSON.parse(JSON.stringify(inbox)).entities[key], entity);
  assertEquals(JSON.parse(JSON.stringify(ops)), ops);
  assertEquals(
    entity.evidence?.requests?.permissions.map((request) => request.arrivedAt),
    [0, 300],
  );
});
