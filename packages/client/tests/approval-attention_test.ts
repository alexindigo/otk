// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  approvalAttention,
  createApprovals,
  type Note,
  NotificationTriggers,
} from "@otk/client";
import type { IndexEntry, PermissionRequest } from "@otk/protocol";

const entry = (
  id: string,
  parentID?: string,
  own = 0,
  children = 0,
): IndexEntry => ({
  id,
  parentID,
  directory: "/p",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "busy",
  attention: {
    permissions: own,
    childPermissions: children,
    questions: 0,
    childQuestions: 0,
  },
});
Deno.test("approval attention stays waiting until authoritative policy and explicit liveness are available", () => {
  const model = createApprovals(
    { call: () => Promise.reject(new Error("No RPC expected")) },
    (id) =>
      id === "root" ? {} : id === "helper" ? { parentID: "root" } : undefined,
  );
  const pending = [{ sessionID: "helper" } as PermissionRequest];
  assertEquals(model.attention(true).permissions(pending), pending);
  assertEquals([
    model.canEnable("root"),
    model.canEnable("helper"),
    model.canEnable("missing"),
  ], [true, false, false]);
  model.receive({
    t: "approvals",
    approvals: { enabled: ["root"], revision: 0 },
  });
  assertEquals(model.attention(false).permissions(pending), pending);
  assertEquals(model.attention(true).permissions(pending), []);
  model.stop();
});
Deno.test("one waiting projection removes only covered subtree attention and restores it when either link is down", () => {
  const rows = [
    entry("root", undefined, 1, 4),
    entry("auto", "root", 1, 2),
    entry("grand", "auto", 2),
    entry("manual", "root", 1),
  ];
  const lookup = (id: string) => rows.find((e) => e.id === id);
  const requests = rows.filter((e) => e.attention.permissions).map((
    e,
  ) => ({ sessionID: e.id } as PermissionRequest));
  const live = approvalAttention(["auto"], lookup, true);
  assertEquals(live.permissions(requests).map((r) => r.sessionID), [
    "root",
    "manual",
  ]);
  assertEquals(
    live.entries(rows).map((
      e,
    ) => [e.attention.permissions, e.attention.childPermissions]),
    [[1, 1], [0, 0], [0, 0], [1, 0]],
  );
  assertEquals(approvalAttention(["auto"], lookup, false).entries(rows), rows);
  assertEquals(
    approvalAttention(["auto"], lookup, false).permissions(requests),
    requests,
  );
  assertEquals(
    rows[0].attention.childPermissions,
    4,
    "native state remains available for reconnect",
  );
});
Deno.test("notification edges and policy/link refresh share the waiting projection", () => {
  const notes: Note[] = [], removed: string[] = [];
  let enabled = ["root"], linked = true;
  const trigger = new NotificationTriggers(
    (note) => notes.push(note),
    (id) => removed.push(id),
    (_sidecar, rows) =>
      approvalAttention(enabled, (id) => rows.find((e) => e.id === id), linked)
        .entries(rows),
  );
  trigger.receive("s", {
    t: "index.snapshot",
    rev: 0,
    entries: [entry("root")],
  });
  trigger.receive("s", {
    t: "index.patch",
    rev: 1,
    ops: [{ op: "upsert", entry: entry("root", undefined, 1) }],
  });
  assertEquals(notes, [], "auto covered request never emits Permission needed");
  linked = false;
  trigger.refresh("s");
  assertEquals(notes.map((n) => n.kind), ["permission"]);
  linked = true;
  trigger.refresh("s");
  assertEquals(removed, ["s/root"]);
  enabled = [];
  trigger.refresh("s");
  assertEquals(notes.map((n) => n.kind), ["permission", "permission"]);
});
