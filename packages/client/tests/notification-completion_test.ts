// SPDX-License-Identifier: LGPL-3.0-only
import { entitySnapshot, sessionEntity } from "./supervision-fixture.ts";
import { assertEquals } from "@std/assert";
import { type Note, NotificationTriggers } from "@otk/client";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

function fixture(finishes: Record<string, number> = {}) {
  const f = shellFixture(), notes: string[] = [], replacements: Note[] = [];
  const trigger = new NotificationTriggers(
    (note, previous) => {
      if (previous) replacements.push(previous);
      notes.push(note.kind);
    },
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
    replacements,
    finish(
      id: string,
      time: number,
      outcome: "succeeded" | "failed" | "unknown" = "succeeded",
      unseen = true,
      terminalOrigin?: "live" | "historical",
    ) {
      f.resources.receive("local", {
        t: "inbox.patch",
        generation: "fixture",
        from: revision,
        revision: revision += 2,
        // A finish clock is not success evidence; borrow the paired supervision outcome.
        ops: [
          {
            op: "entity.upsert",
            value: sessionEntity(id, {
              state: unseen ? "finishedUnseen" : "none",
              unseen,
              terminal: time,
              outcome: outcome === "unknown" ? undefined : outcome,
              terminalOrigin,
            }),
          },
          { op: "finish", sessionID: id, time },
        ],
      });
    },
  };
}

Deno.test("same-terminal failure enriches a live outcome but does not revive acknowledged or historical finishes", () => {
  const f = fixture();
  try {
    f.finish("root", 10, "unknown", true, "historical");
    f.finish("root", 10, "failed", true, "historical");
    assertEquals(f.notes, []);
    f.finish("root", 20, "unknown", true, "live");
    f.finish("root", 20, "failed");
    assertEquals(f.notes, ["info", "error"]);
    assertEquals(f.replacements.map((note) => note.kind), ["info"]);
    f.finish("root", 30, "unknown", true, "live");
    f.finish("root", 30, "unknown", false, "live");
    f.finish("root", 30, "failed", false);
    f.finish("root", 30, "failed", true, "live");
    assertEquals(f.notes, ["info", "error", "info"]);
  } finally {
    f.resources.stop();
  }
});

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

Deno.test("a replacement view baseline remains silent even with a newer historical finish", () => {
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
        entities: entitySnapshot({
          supervision: {
            root: {
              state: "finishedUnseen",
              terminal: 10,
              unseen: true,
              outcome: "succeeded",
            },
            historical: {
              state: "finishedUnseen",
              unseen: true,
              terminal: 5,
              outcome: "succeeded",
            },
          },
        }),
        pathTemplates: [],
      },
    });
    assertEquals(f.notes, []);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("historical"), status: "idle" },
      }],
    });
    assertEquals(f.notes, []);
  } finally {
    f.resources.stop();
  }
});

Deno.test("a helper completion notifies once and reparenting cannot notify it again", () => {
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
    assertEquals(f.notes, ["done"]);
    f.resources.receive("local", {
      t: "index.patch",
      rev: 2,
      ops: [{
        op: "upsert",
        entry: { ...shellEntry("helper"), status: "idle" },
      }],
    });
    assertEquals(f.notes, ["done"]);
  } finally {
    f.resources.stop();
  }
});
