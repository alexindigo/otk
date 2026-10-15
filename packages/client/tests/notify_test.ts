// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DEFAULT_PREFS, type IndexEntry } from "@otk/protocol";
import {
  type Note,
  type NoteDelivery,
  NotificationHub,
  notificationPolicy,
  NotificationTriggers,
} from "@otk/client";
const entry = (id = "a", change: Partial<IndexEntry> = {}): IndexEntry => ({
  id,
  directory: "/project",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
  ...change,
});
const note = (change: Partial<Note> = {}): Note => ({
  id: "s/a",
  kind: "done",
  title: "Done",
  sessionRef: { sidecar: "s", session: "a" },
  actions: [{ label: "Open", command: "open", default: true }],
  ...change,
});
Deno.test("notification triggers baseline per connection, batched root roll-up, priority, replay and resolution", () => {
  const emitted: Note[] = [], removed: string[] = [];
  const triggers = new NotificationTriggers(
    (n) => emitted.push(n),
    (id) => removed.push(id),
  );
  const a = entry("a", { status: "busy" });
  triggers.receive("s", { t: "index.snapshot", rev: 1, entries: [a] });
  assertEquals(emitted, []);
  triggers.receive("s", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "upsert", entry: entry() }],
  });
  assertEquals(emitted.map((n) => [n.id, n.kind]), [["s/a", "done"]]);
  assertEquals(
    triggers.receive("s", {
      t: "index.patch",
      rev: 2,
      ops: [{ op: "upsert", entry: a }],
    }),
    false,
  );
  const child = entry("child", {
    parentID: "a",
    attention: { ...a.attention, permissions: 1 },
  });
  const root = entry("a", {
    attention: { ...a.attention, childPermissions: 1 },
  });
  triggers.receive("s", {
    t: "index.patch",
    rev: 4,
    ops: [{ op: "upsert", entry: child }, { op: "upsert", entry: root }],
  });
  assertEquals(emitted.map((n) => n.kind), ["done", "permission"]);
  triggers.receive("s", {
    t: "index.snapshot",
    rev: 4,
    entries: [root, child],
  });
  assertEquals(emitted.length, 2);
  triggers.receive("s", {
    t: "index.patch",
    rev: 5,
    ops: [{ op: "upsert", entry: entry() }],
  });
  assertEquals(removed.at(-1), "s/a");
  triggers.reset("s");
  triggers.receive("s", { t: "index.snapshot", rev: 8, entries: [root] });
  assertEquals(emitted.length, 2);
  triggers.receive("other", { t: "index.snapshot", rev: 1, entries: [a] });
  triggers.receive("other", {
    t: "index.patch",
    rev: 2,
    ops: [{ op: "upsert", entry: entry() }],
  });
  assertEquals(emitted.at(-1)?.id, "other/a");
});
Deno.test("new genuine error observations alert even with identical text; inactive revisions do not", () => {
  const emitted: Note[] = [];
  const triggers = new NotificationTriggers((n) => emitted.push(n), () => {});
  triggers.receive("s", { t: "index.snapshot", rev: 1, entries: [entry()] });
  const error = (revision: number, id: string, cleared = false) =>
    entry("a", {
      attention: {
        ...entry().attention,
        error: cleared ? undefined : "Native failure",
        errorState: {
          revision,
          observations: [{
            id,
            source: "event",
            message: "Native failure",
            cleared,
          }],
        },
      },
    });
  for (
    const [rev, e] of [[2, error(1, "first")], [3, error(2, "second")], [
      4,
      error(3, "second"),
    ], [5, error(4, "second", true)]] as const
  ) {
    triggers.receive("s", {
      t: "index.patch",
      rev,
      ops: [{ op: "upsert", entry: e }],
    });
  }
  assertEquals(emitted.map((n) => n.kind), ["error", "error"]);
});
Deno.test("notification policy focus/open/hidden, unavailable OS fallback, general messages and optional channels", () => {
  const ctx = {
    focused: true,
    visible: true,
    prefs: { ...DEFAULT_PREFS },
    open: { sidecar: "s", session: "b" },
  };
  const policy = notificationPolicy(() => ctx);
  assertEquals(policy(note(), () => true, true).channels, ["toast", "badge"]);
  ctx.open.session = "a";
  assertEquals(policy(note(), () => true, true).channels, []);
  ctx.visible = false;
  ctx.prefs["notify.os"] = true;
  ctx.prefs["notify.sound"] = true;
  assertEquals(policy(note(), () => true, true).channels, [
    "os",
    "sound",
    "badge",
  ]);
  assertEquals(policy(note(), () => false, true).channels, [
    "toast",
    "sound",
    "badge",
  ]);
  assertEquals(policy(note(), () => true, false).channels, ["os", "badge"]);
  ctx.prefs["notify.toast"] = false;
  ctx.prefs["notify.badge"] = false;
  assertEquals(
    policy(note({ sessionRef: undefined }), () => false, true).channels,
    ["toast"],
  );
});
Deno.test("delivery ownership prevents stale timers/actions/async enrichment from consuming replacements", async () => {
  const calls: unknown[] = [],
    ports: NoteDelivery[] = [],
    retracted: string[] = [];
  const hub = new NotificationHub(
    () => ({ channels: ["custom"] }),
    (id, args) => {
      calls.push([id, args]);
      return Promise.resolve();
    },
    (error) => {
      throw error;
    },
  );
  const release = hub.registerChannel({
    id: "custom",
    available: () => true,
    deliver: (_n, port) => ports.push(port),
    retract: (id) => retracted.push(id),
  });
  assertThrows(() =>
    hub.registerChannel({
      id: "custom",
      available: () => true,
      deliver() {},
      retract() {},
    })
  );
  const old = hub.publish(note()),
    replacement = hub.publish(note({ kind: "permission" }));
  ports[0].dismiss();
  await ports[0].invoke(old.actions[0]);
  assertEquals(calls, []);
  assert(hub.current(replacement));
  assertEquals(hub.replace(old, note()), undefined);
  await ports[1].invoke(replacement.actions[0]);
  assertEquals(calls, [["open", undefined]]);
  assert(
    hub.current(replacement),
    "A command resolution does not prove selection",
  );
  hub.viewed("other", "a");
  assert(hub.current(replacement));
  hub.viewed("s", "a");
  assert(!hub.current(replacement));
  release();
  release();
  assertEquals(retracted, ["s/a", "s/a"]);
});
Deno.test("delivery failure falls back at the channel consumer and release/focus retract persistent notes", () => {
  const received: string[] = [];
  const hub = new NotificationHub(
    () => ({
      channels: ["os", "badge"],
      fallback: { from: "os", to: "toast" },
    }),
    async () => {},
    () => {},
  );
  hub.registerChannel({
    id: "os",
    available: () => true,
    deliver(_n, port) {
      port.unavailable();
    },
    retract() {},
  });
  for (const id of ["toast", "badge"]) {
    hub.registerChannel({
      id,
      available: () => true,
      deliver() {
        received.push(id);
      },
      retract() {
        received.push("-" + id);
      },
    });
  }
  hub.publish(note());
  assertEquals(received, ["toast", "badge"]);
  hub.retractChannel("os");
  hub.viewed("s", "a");
  assertEquals(received, ["toast", "badge", "-toast", "-badge"]);
  hub.stop();
});
Deno.test("root notification resolution retains other pending family attention instead of clearing the badge", () => {
  const emitted: Note[] = [], removed: string[] = [];
  const triggers = new NotificationTriggers(
    (n) => emitted.push(n),
    (id) => removed.push(id),
  );
  triggers.receive("s", { t: "index.snapshot", rev: 1, entries: [entry()] });
  triggers.receive("s", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "upsert",
      entry: entry("a", {
        attention: { ...entry().attention, childPermissions: 1, questions: 1 },
      }),
    }],
  });
  triggers.receive("s", {
    t: "index.patch",
    rev: 3,
    ops: [{
      op: "upsert",
      entry: entry("a", { attention: { ...entry().attention, questions: 1 } }),
    }],
  });
  assertEquals(emitted.map((n) => n.kind), ["permission", "question"]);
  assertEquals(removed, []);
  triggers.receive("s", {
    t: "index.patch",
    rev: 4,
    ops: [{ op: "upsert", entry: entry() }],
  });
  assertEquals(removed, ["s/a"]);
});
Deno.test("question edges, archive/remove and async command completion preserve exact note lifetime", async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ports: NoteDelivery[] = [];
  const hub = new NotificationHub(
    () => ({ channels: ["custom"] }),
    () => wait,
    (error) => {
      throw error;
    },
  );
  hub.registerChannel({
    id: "custom",
    available: () => true,
    deliver: (_n, p) => ports.push(p),
    retract() {},
  });
  const old = hub.publish(note());
  const action = ports[0].invoke(old.actions[0]);
  const newer = hub.publish(note({ kind: "question" }));
  finish();
  await action;
  assert(hub.current(newer));
  const emitted: Note[] = [], removed: string[] = [];
  const triggers = new NotificationTriggers(
    (n) => emitted.push(n),
    (id) => removed.push(id),
  );
  triggers.receive("s", { t: "index.snapshot", rev: 1, entries: [entry()] });
  triggers.receive("s", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "upsert",
      entry: entry("a", {
        attention: { ...entry().attention, childQuestions: 1 },
      }),
    }],
  });
  assertEquals(emitted.map((n) => n.kind), ["question"]);
  triggers.receive("s", {
    t: "index.patch",
    rev: 3,
    ops: [{ op: "upsert", entry: entry("a", { archived: true }) }],
  });
  assertEquals(removed, ["s/a"]);
  hub.stop();
});
Deno.test("queued default actions survive presentation retraction but never note replacement, viewing or registration release", async () => {
  const calls: string[] = [], ports: NoteDelivery[] = [];
  const hub = new NotificationHub(() => ({ channels: ["custom"] }), (id) => {
    calls.push(id);
    return Promise.resolve();
  }, (error) => {
    throw error;
  });
  const release = hub.registerChannel({
    id: "custom",
    available: () => true,
    deliver: (_n, port) => ports.push(port),
    retract() {},
  });
  const first = hub.publish(note());
  hub.retractChannel("custom");
  assertEquals(ports[0].current(), false);
  assertEquals(ports[0].currentNote(), true);
  await ports[0].invoke(first.actions[0]);
  assertEquals(calls, []);
  await ports[0].invokeDefault();
  assertEquals(calls, ["open"]);
  hub.publish(note());
  await ports[0].invokeDefault();
  assertEquals(calls, ["open"]);
  hub.viewed("s", "a");
  await ports[1].invokeDefault();
  assertEquals(calls, ["open"]);
  hub.publish(note());
  release();
  await ports[2].invokeDefault();
  assertEquals(calls, ["open"]);
  hub.stop();
});
