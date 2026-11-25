// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createAttentionProjection,
  createIndex,
  createState,
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
Deno.test("digest-only updates preserve attention reader clocks while full keyed values remain current", () => {
  const index = createIndex();
  let keys: Record<string, number> = {};
  const owner = createAttentionProjection({
    entry: (id) => index.get("s", id),
    ids: () => index.ids("s"),
    factory(initial) {
      keys = (initial as { keys: Record<string, number> }).keys;
      return createState(initial);
    },
  });
  index.receive("s", { t: "index.snapshot", rev: 0, entries: [row("root")] });
  owner.update(index.changes("s")!.ids, true);
  const before = { ...keys };
  index.receive("s", {
    t: "index.patch",
    rev: 1,
    ops: [{
      op: "digest",
      id: "root",
      revision: 1,
      summary: { state: "ready", revision: 1 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  owner.update(index.changes("s")!.ids);
  assertEquals(keys, before);
  assertEquals(owner.get("root")?.digest.state, "ready");
});
