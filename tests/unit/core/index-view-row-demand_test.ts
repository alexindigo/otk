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

Deno.test("transcript references admit only known sessions, independently of sidebar rows", () => {
  const index = new IndexStore(), client = createIndex();
  const parent = entry("tstv1-parent", "/repo");
  const child = entry("tstv1-child", "/worktree", parent.id);
  const unknown = "tstv1-unknown";
  index.upsert(parent);
  index.upsert(child);
  index.flush();
  let scope: ViewLease = {
    epoch: 0,
    selected: parent.id,
    crumbs: [],
    rows: [],
  };
  let rev = 0;
  const view = new IndexView(index, () => scope, () => [], (frame) => {
    if (frame.t === "index.snapshot" || frame.t === "index.patch") {
      assertEquals(client.receive("s", frame), true);
      rev = frame.rev;
    }
  });
  const stop = index.listen((frame) => view.refresh(frame));
  try {
    view.snapshot();
    assertEquals(client.get("s", child.id), undefined);
    view.applied(0, rev);
    scope = { ...scope, epoch: 1, references: [child.id, unknown] };
    view.refresh();
    assertEquals(client.get("s", child.id)?.title, child.title);
    assertEquals(client.get("s", child.id)?.digest.turns, {});
    assertEquals(client.get("s", unknown), undefined);
    view.applied(1, rev);
    index.upsertMetadata({ ...child, title: "Updated" });
    index.flush();
    assertEquals(client.get("s", child.id)?.title, "Updated");
    view.applied(1, rev);
    scope = { ...scope, epoch: 2, references: [] };
    view.refresh();
    assertEquals(client.get("s", child.id), undefined);
  } finally {
    stop();
    view.close();
  }
});

Deno.test("index epoch replay reports restored admissions but not content-only updates", () => {
  const index = new IndexStore(), row = entry("tstv1-restored", "/p");
  index.upsert(row);
  index.flush();
  let scope: ViewLease = { epoch: 0, rows: [row.id], crumbs: [] };
  const frames: { frame: ServerFrame; moved?: readonly string[] }[] = [];
  const lease = new IndexView(index, () => scope, () => [], (frame, moved) => {
    frames.push({ frame, moved });
  });
  const stop = index.listen((frame) => lease.refresh(frame));
  try {
    lease.snapshot();
    lease.applied(0, 0);
    scope = { ...scope, epoch: 1, rows: [] };
    lease.refresh();
    assertEquals(frames.at(-1)?.moved, [row.id]);
    // The eviction reached the inbox owner, but its credit has not returned.
    scope = { ...scope, epoch: 2, rows: [row.id] };
    lease.refresh();
    assertEquals(frames.at(-1)?.moved, [row.id]);
    const replay = frames.at(-1)!.frame;
    if (replay.t !== "index.patch") throw new Error("Expected replay patch");
    assertEquals(replay.ops.map((op) => op.op), ["upsert"]);
    lease.applied(2, replay.rev);
    index.upsertMetadata({ ...row, title: "Changed content" });
    index.flush();
    lease.refresh();
    assertEquals(frames.at(-1)?.moved, []);
  } finally {
    stop();
    lease.close();
  }
});

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
