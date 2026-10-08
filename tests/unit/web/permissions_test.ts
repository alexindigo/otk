// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  belongsToSession,
  sessionAncestors,
} from "../../../protocol/session-tree.ts";
import type { PermissionRequest } from "../../../protocol/content.ts";
import { oldestPermission } from "../../../web/src/state/permissions.ts";
import { emptyContent, reduce } from "../../../web/src/state/reduce.ts";
const nodes: Record<string, { parentID?: string }> = {
  root: {},
  child: { parentID: "root" },
  grandchild: { parentID: "child" },
  other: {},
  cycleA: { parentID: "cycleB" },
  cycleB: { parentID: "cycleA" },
};
const lookup = (id: string) => nodes[id];
const request = (
  id: string,
  sessionID: string,
  time: number,
): PermissionRequest => ({
  id,
  sessionID,
  time,
  kind: "bash",
  title: "bash",
  patterns: ["echo otk"],
  alwaysPatterns: ["echo *"],
  detail: { kind: "bash", command: "echo otk" },
});
Deno.test("permission family follows every ancestor, isolates siblings and terminates cycles", () => {
  assertEquals(sessionAncestors("grandchild", lookup), ["child", "root"]);
  assert(belongsToSession("root", "root", lookup));
  assert(belongsToSession("grandchild", "root", lookup));
  assert(!belongsToSession("other", "root", lookup));
  assert(!belongsToSession("root", "child", lookup));
  assertEquals(sessionAncestors("cycleA", lookup), ["cycleB"]);
  assertEquals(sessionAncestors("missing", lookup), []);
});
Deno.test("permission selector shows oldest descendant and ignores an earlier unrelated request", () => {
  const old = request("old", "grandchild", 2),
    newer = request("new", "root", 4),
    unrelated = request("other", "other", 1);
  assertEquals(oldestPermission([newer, unrelated, old], "root", lookup), old);
  assertEquals(oldestPermission([unrelated], "root", lookup), undefined);
});
Deno.test("permission updates preserve oldest-arrival ties, deduplicate IDs and remove answered requests", () => {
  const old = request("zzz", "child", 2), next = request("aaa", "root", 2);
  let state = reduce(emptyContent(), { op: "permission.upsert", request: old });
  state = reduce(state, { op: "permission.upsert", request: next });
  state = reduce(state, {
    op: "permission.upsert",
    request: { ...old, title: "updated" },
  });
  assertEquals(state.permissions.map((p) => p.id), ["zzz", "aaa"]);
  state = reduce(state, {
    op: "permission.remove",
    requestID: "zzz",
    sessionID: "child",
  });
  assertEquals(oldestPermission(state.permissions, "root", lookup), next);
});
