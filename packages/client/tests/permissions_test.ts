// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { PermissionRequest } from "@otk/protocol";
import { emptyContent, oldestPermission, reduce } from "@otk/client";
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
