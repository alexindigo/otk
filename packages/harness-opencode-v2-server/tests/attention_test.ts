// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { pendingAttention, PendingAttentionIndex } from "../attention.ts";
Deno.test("V2 pending projection routes each request through its complete ancestor path without double counting", () => {
  const entries = {
    child: { parentID: "parent" },
    parent: { parentID: "root" },
    root: {},
  };
  const lookup = (id: string) => entries[id as keyof typeof entries];
  const requests = [{ sessionID: "child", kind: "permission" as const }, {
    sessionID: "child",
    kind: "form" as const,
    stale: true,
  }];
  assertEquals(pendingAttention("child", requests, lookup), {
    attention: {
      permissions: 1,
      questions: 1,
      childPermissions: 0,
      childQuestions: 0,
    },
    stale: true,
  });
  for (const id of ["parent", "root"]) {
    assertEquals(pendingAttention(id, requests, lookup), {
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 1,
        childQuestions: 1,
      },
      stale: true,
    });
  }
  assertEquals(pendingAttention("other", requests, lookup).attention, {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  });
});

Deno.test("V2 incremental pending deltas never scan unrelated requests or families", () => {
  const entries = new Map<string, { id: string; parentID?: string }>([
    ["child", { id: "child", parentID: "root" }],
    ["root", { id: "root" }],
    ["other", { id: "other" }],
  ]);
  let lookups = 0;
  const index = new PendingAttentionIndex((id) => {
    lookups++;
    return entries.get(id);
  });
  for (let i = 0; i < 1000; i++) {
    index.set(`unrelated-${i}`, {
      id: String(i),
      sessionID: `unrelated-${i}`,
      kind: "permission",
    });
  }
  lookups = 0;
  index.set("permission", {
    id: "permission",
    sessionID: "child",
    kind: "permission",
  });
  index.set("form", {
    id: "form",
    sessionID: "child",
    kind: "form",
    stale: true,
  });
  assertEquals(index.get("root").attention.childPermissions, 1);
  assertEquals(index.get("root").stale, true);
  assertEquals(index.get("child").permissions, ["permission"]);
  assertEquals(index.get("child").inputs, []);
  assert(lookups < 10, `Changed paths only, got ${lookups} lookups`);
  const changed = index.reparent({ id: "child", parentID: "other" });
  entries.set("child", { id: "child", parentID: "other" });
  assertEquals([...changed].sort(), ["child", "other", "root"]);
  assertEquals(index.get("root").attention.childPermissions, 0);
  assertEquals(index.get("other").attention.childPermissions, 1);
  index.set("permission");
  index.set("form");
  assertEquals(index.get("other").attention.childPermissions, 0);
  assertEquals(index.get("other").stale, false);
});
