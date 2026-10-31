// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  approvalAttention,
  createAttentionProjection,
  createIndex,
  type EntryChanges,
} from "@otk/client";
import type { IndexEntry } from "@otk/protocol";
const row = (
  id: string,
  parentID?: string,
  own = 0,
  children = 0,
): IndexEntry => ({
  id,
  parentID,
  title: id,
  directory: "/p",
  projectID: "p",
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "busy",
  digest: { state: "digesting", revision: 0, turns: {} },
  attention: {
    permissions: own,
    childPermissions: children,
    questions: 0,
    childQuestions: 0,
  },
});
Deno.test("keyed attention maintains covered boundaries through count, reparent, policy and link deltas", () => {
  const index = createIndex(), frames: EntryChanges[] = [];
  let reads = 0;
  const owner = createAttentionProjection({
    entry: (id) => {
      reads++;
      return index.get("s", id);
    },
    ids: () => index.ids("s"),
    children: (id) => index.children("s", id),
  });
  owner.subscribe((change) => frames.push(change));
  index.receive("s", {
    t: "index.snapshot",
    rev: 0,
    entries: [
      row("root", undefined, 1, 4),
      row("auto", "root", 1, 2),
      row("grand", "auto", 2),
      row("manual", "root", 1),
      ...Array.from({ length: 1000 }, (_, n) => row(`idle-${n}`)),
    ],
  });
  owner.configure(["auto"], true);
  owner.update(index.changes("s")!.metadata, true);
  const check = () =>
    assertEquals(
      index.ids("s").map((id) => owner.get(id)),
      approvalAttention(["auto"], (id) => index.get("s", id), true).entries(
        index.partition("s"),
      ),
    );
  check();
  const manual = owner.get("manual");
  frames.length = 0;
  index.receive("s", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "upsert",
      entry: { ...row("grand", "auto", 2), title: "Renamed" },
    }],
  });
  reads = 0;
  owner.update(index.changes("s")!.metadata);
  assertEquals(
    reads < 20,
    true,
    "one title cannot enumerate unrelated identities",
  );
  assertEquals(frames.at(-1)!.changes.map((change) => change.id), ["grand"]);
  assertStrictEquals(owner.get("manual"), manual);
  check();
  index.receive("s", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "upsert", entry: row("auto", "missing", 1, 2) }],
  });
  owner.update(index.changes("s")!.metadata);
  check();
  owner.configure(["auto"], false);
  assertEquals(owner.get("grand")!.attention.permissions, 2);
  owner.configure(["auto"], true);
  check();
  index.receive("s", {
    t: "index.patch",
    rev: 3,
    ops: [{ op: "remove", id: "auto" }],
  });
  owner.update(index.changes("s")!.metadata);
  check();
});

Deno.test("attention deltas match the full contract across nested policies, cycles and missing ancestors", () => {
  const index = createIndex();
  const owner = createAttentionProjection({
    entry: (id) => index.get("s", id),
    ids: () => index.ids("s"),
    children: (id) => index.children("s", id),
  });
  const rows = Array.from(
    { length: 32 },
    (_, n) =>
      row(`n${n}`, n ? `n${Math.floor((n - 1) / 2)}` : undefined, n % 3, n % 7),
  );
  index.receive("s", { t: "index.snapshot", rev: 0, entries: rows });
  let policies = ["n1", "n3"], linked = true;
  owner.configure(policies, linked);
  owner.update(index.changes("s")!.ids, true);
  for (let n = 1; n <= 100; n++) {
    const id = `n${n % 32}`, current = index.get("s", id)!;
    index.receive("s", {
      t: "index.patch",
      rev: n,
      ops: [{
        op: "upsert",
        entry: {
          ...current,
          parentID: n % 5
            ? current.parentID
            : n % 2
            ? "missing"
            : `n${(n + 7) % 32}`,
          attention: {
            ...current.attention,
            permissions: n % 4,
            childPermissions: n % 9,
          },
        },
      }],
    });
    owner.update(index.changes("s")!.ids);
    if (n % 7 === 0) {
      policies = n % 2 ? ["n2", "n4"] : ["n1", "n3"];
      owner.configure(policies, linked);
    }
    if (n % 11 === 0) {
      linked = !linked;
      owner.configure(policies, linked);
    }
    assertEquals(
      index.ids("s").map((id) => owner.get(id)),
      approvalAttention(policies, (id) => index.get("s", id), linked).entries(
        index.partition("s"),
      ),
      `turn ${n}`,
    );
  }
});
