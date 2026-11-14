// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createIndex } from "@otk/client";
import {
  type IndexEntry,
  knownDerived,
  type ServerFrame,
  type ViewLease,
} from "@otk/protocol";
import { IndexStore } from "../../../core/index/store.ts";
import { IndexView } from "../../../core/index/view.ts";

function entry(id: string, directory: string, parentID?: string): IndexEntry {
  return {
    id,
    directory,
    parentID,
    projectID: "repo",
    title: id,
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
    digest: {
      state: "ready",
      revision: 1,
      turns: {
        turn: knownDerived(
          {
            calls: 1,
            cost: 0,
            contextPeak: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          id,
          1,
        ),
      },
    },
  };
}

for (const selected of [false, true]) {
  Deno.test(`index view retains explicit foreign-checkout rows through publication and release (selected: ${selected})`, () => {
    const index = new IndexStore(), client = createIndex();
    const root = entry("tstv1-root", "/repo");
    const child = entry("tstv1-child", "/worktree", root.id);
    index.upsert(root);
    index.upsert(child);
    index.upsert(entry("tstv1-unrequested", "/repo"));
    index.flush();
    let scope: ViewLease = {
      epoch: 0,
      directory: "/repo",
      crumbs: [],
      rows: [child.id],
      ...(selected ? { selected: root.id } : {}),
    };
    const frames: Extract<
      ServerFrame,
      { t: "index.snapshot" | "index.patch" }
    >[] = [];
    const lease = new IndexView(index, () => scope, () => [], (frame) => {
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        frames.push(frame);
        assertEquals(client.receive("s", frame), true);
      }
    });
    const acknowledge = () => lease.applied(scope.epoch, frames.at(-1)!.rev);
    let stop = () => {};
    try {
      lease.snapshot();
      assertEquals([...client.ids("s")].sort(), [child.id, root.id].sort());
      assertEquals(
        client.get("s", child.id)?.digest.turns,
        {},
        "visible rows acquire metadata, not turn detail",
      );
      acknowledge();
      stop = index.listen((frame) => lease.refresh(frame));
      index.upsertMetadata({
        ...child,
        directory: "/moved-worktree",
        title: "Moved child",
      });
      index.flush();
      assertEquals(client.getMetadata("s", child.id)?.title, "Moved child");
      assertEquals(
        client.getMetadata("s", child.id)?.directory,
        "/moved-worktree",
      );
      acknowledge();
      scope = { ...scope, epoch: 1, rows: [] };
      lease.refresh();
      assertEquals(client.get("s", child.id), undefined);
      assertEquals([...client.ids("s")], selected ? [root.id] : []);
    } finally {
      stop();
      lease.close();
    }
  });
}
