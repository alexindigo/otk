// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { NotificationTriggers } from "@otk/client";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

function fixture(finishes: Record<string, number> = {}) {
  const f = shellFixture(), notes: string[] = [];
  const trigger = new NotificationTriggers(
    (note) => notes.push(note.kind),
    () => {},
  );
  f.resources.observeEntries(
    "local",
    (change) => trigger.entriesChanged("local", change),
  );
  f.resources.receive("local", {
    t: "index.snapshot",
    rev: 0,
    entries: [{ ...shellEntry("root"), status: "idle" }],
  });
  f.resources.receive("local", {
    t: "inbox.snapshot",
    generation: "fixture",
    revision: 0,
    inbox: { projects: [], tasks: [], seen: {}, finishes, pathTemplates: [] },
  });
  let revision = 0;
  return {
    ...f,
    notes,
    finish(id: string, time: number) {
      f.resources.receive("local", {
        t: "inbox.patch",
        generation: "fixture",
        from: revision,
        revision: ++revision,
        ops: [{ op: "finish", sessionID: id, time }],
      });
    },
  };
}

Deno.test("authoritative finish clocks notify when scoped publication skipped the busy frame", () => {
  const f = fixture();
  try {
    f.finish("root", 10);
    assertEquals(f.notes, ["done"]);
    f.finish("root", 10);
    assertEquals(f.notes, ["done"]);
    f.finish("root", 20);
    assertEquals(f.notes, ["done", "done"]);
  } finally {
    f.resources.stop();
  }
});

Deno.test("a finish before routing metadata waits for that identity and survives eviction without repeating", () => {
  const f = fixture();
  try {
    f.finish("later", 10);
    assertEquals(f.notes, []);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("later"), status: "idle" },
      }],
    });
    assertEquals(f.notes, ["done"]);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 2,
      ops: [{ op: "evict", id: "later" }],
    });
    f.resources.receive("local", {
      t: "index.patch",
      rev: 3,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("later"), status: "idle" },
      }],
    });
    assertEquals(f.notes, ["done"]);
  } finally {
    f.resources.stop();
  }
});

Deno.test("historical finishes stay silent and a live finish is not duplicated by its idle frame", () => {
  const f = fixture({ root: 5 });
  try {
    assertEquals(f.notes, []);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{ op: "upsert", entry: { ...shellEntry("root"), status: "busy" } }],
    });
    f.finish("root", 10);
    assertEquals(f.notes, []);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 2,
      ops: [{ op: "upsert", entry: { ...shellEntry("root"), status: "idle" } }],
    });
    assertEquals(f.notes, ["done"]);
    f.finish("root", 10);
    assertEquals(f.notes, ["done"]);
  } finally {
    f.resources.stop();
  }
});

Deno.test("a replacement view baseline preserves a finish newer than an already observed root", () => {
  const f = fixture();
  try {
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "fixture",
      revision: 1,
      inbox: {
        projects: [],
        tasks: [],
        seen: {},
        finishes: { root: 10, historical: 5 },
        pathTemplates: [],
      },
    });
    assertEquals(f.notes, ["done"]);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("historical"), status: "idle" },
      }],
    });
    assertEquals(f.notes, ["done"]);
  } finally {
    f.resources.stop();
  }
});

Deno.test("a helper completion cannot become a new root notification after reparenting", () => {
  const f = fixture();
  try {
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("helper", "/p", "root"), status: "idle" },
      }],
    });
    f.finish("helper", 10);
    assertEquals(f.notes, []);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 2,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("helper"), status: "idle" },
      }],
    });
    assertEquals(f.notes, []);
  } finally {
    f.resources.stop();
  }
});
