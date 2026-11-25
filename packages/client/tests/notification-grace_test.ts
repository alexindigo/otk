// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import { createAttentionGrace } from "../attention-grace.ts";
import { NotificationTriggers } from "../notification-triggers.ts";
function fixture() {
  let now = 0, seq = 0, revision = 0;
  const timers = new Map<number, { due: number; run(): void }>();
  const grace = createAttentionGrace({
    clock: {
      now: () => now,
      set(run, ms) {
        timers.set(++seq, { due: now + ms, run });
        return seq;
      },
      clear(id) {
        timers.delete(id as number);
      },
    },
  });
  const notes: string[] = [], requests: (string | undefined)[] = [];
  const quiet: boolean[] = [];
  const removed: string[] = [];
  const trigger: NotificationTriggers = Reflect.construct(
    NotificationTriggers,
    [
      (note: { kind: string; dismissalKey?: string }, previous?: unknown) => {
        notes.push(note.kind);
        requests.push(note.dismissalKey);
        quiet.push(!!previous);
      },
      (id: string) => removed.push(id),
      undefined,
      undefined,
      undefined,
      grace,
    ],
  );
  const send = (keys: string[], questions = 0) => {
    const entry: IndexEntry = {
      id: "s",
      title: "Session",
      directory: "/p",
      projectID: "p",
      timeCreated: 1,
      timeUpdated: 1,
      archived: false,
      status: "busy",
      digest: { state: "digesting", revision: 0, turns: {} },
      attention: {
        permissions: keys.length,
        questions,
        childPermissions: 0,
        childQuestions: 0,
      },
      activity: { permissions: { keys, fresh: true } },
    };
    trigger.receive(
      "a",
      revision
        ? { t: "index.patch", rev: ++revision, ops: [{ op: "upsert", entry }] }
        : { t: "index.snapshot", rev: ++revision, entries: [entry] },
    );
  };
  const tick = (ms: number) => {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) =>
        t.due <= end
      ).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) {
        break;
      }
      now = next[1].due;
      timers.delete(next[0]);
      next[1].run();
    }
    now = end;
  };
  send([]);
  return {
    grace,
    notes,
    requests,
    quiet,
    removed,
    send,
    tick,
    stop: () => {
      trigger.reset("a");
      grace.stop();
    },
  };
}
Deno.test("WP5 auto-approved permission produces no notification", () => {
  const f = fixture();
  try {
    f.send(["p"]);
    f.tick(200);
    f.send([]);
    f.tick(500);
    assertEquals(f.notes, []);
  } finally {
    f.stop();
  }
});
Deno.test("WP5 held permission borrows arrival deadline and notifies once", () => {
  const f = fixture();
  try {
    f.grace.permission("a", "s", "p");
    f.tick(300);
    f.send(["p"]);
    f.tick(199);
    assertEquals(f.notes, []);
    f.tick(1);
    assertEquals(f.notes, ["permission"]);
    assertEquals(f.requests, ["permission/p"]);
    f.send(["p"]);
    f.tick(1000);
    assertEquals(f.notes, ["permission"]);
  } finally {
    f.stop();
  }
});
Deno.test("WP5 question notification is immediate", () => {
  const f = fixture();
  try {
    f.send([], 1);
    assertEquals(f.notes, ["question"]);
  } finally {
    f.stop();
  }
});
Deno.test("WP5 question remains immediate alongside a permission arrival", () => {
  const f = fixture();
  try {
    f.send(["p"], 1);
    assertEquals(f.notes, ["question"]);
  } finally {
    f.stop();
  }
});
Deno.test("WP5 rapid replacement cannot postpone a surviving request", () => {
  const f = fixture();
  try {
    f.send(["survives", "short"]);
    f.tick(300);
    f.send(["survives", "replacement"]);
    f.tick(199);
    assertEquals(f.notes, []);
    f.tick(1);
    assertEquals(f.notes, ["permission"]);
    f.tick(300);
    assertEquals(f.notes, ["permission", "permission"]);
    assertEquals(f.requests, ["permission/survives", "permission/replacement"]);
  } finally {
    f.stop();
  }
});
Deno.test("WP5 settlement restores remaining eligible request facts without another fresh alert", () => {
  const f = fixture();
  try {
    f.send(["p", "q"]);
    f.tick(500);
    f.grace.observe("a", "unrelated", {
      inputs: { keys: ["question"], fresh: true },
    });
    assertEquals(f.requests, ["permission/p", "permission/q"]);
    // Content settlement may arrive before the index count changes. The note
    // must no longer offer an action for q while the already-alerted p remains.
    f.grace.settled("a", "q");
    assertEquals(f.requests, ["permission/p", "permission/q", "permission/p"]);
    assertEquals(f.quiet, [false, false, true]);
    f.grace.settled("a", "p");
    assertEquals(f.removed, ["a/s"]);
  } finally {
    f.stop();
  }
});
