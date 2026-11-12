// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { IndexEntry } from "@otk/protocol";
import {
  type NoteDelivery,
  NotificationHub,
  NotificationTriggers,
} from "@otk/client";

Deno.test("digest updates preserve notification actions, badge membership and delivery ownership until real eviction", async () => {
  const entry: IndexEntry = {
    id: "tstv1-notification",
    directory: "/p",
    projectID: "p",
    title: "Retained completion",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "busy",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
    digest: { state: "digesting", revision: 0, turns: {} },
  };
  const delivered = new Map<string, NoteDelivery>(),
    retracted: string[] = [],
    calls: string[] = [];
  const hub = new NotificationHub(
    () => ({ channels: ["toast", "badge", "os"] }),
    (command) => {
      calls.push(command);
      return Promise.resolve();
    },
    (error) => {
      throw error;
    },
  );
  for (const id of ["toast", "badge", "os"]) {
    hub.registerChannel({
      id,
      available: () => true,
      deliver(_note, delivery) {
        delivered.set(id, delivery);
      },
      retract() {
        retracted.push(id);
        delivered.delete(id);
      },
    });
  }
  const triggers = new NotificationTriggers((note) => {
    hub.publish(note);
  }, (id) => hub.retract(id));
  triggers.receive("server", { t: "index.snapshot", rev: 1, entries: [entry] });
  triggers.receive("server", {
    t: "index.patch",
    rev: 2,
    ops: [{
      op: "upsert",
      entry: { ...entry, status: "idle", activity: { terminal: 2 } },
    }],
  });
  assertEquals([...delivered.keys()], ["toast", "badge", "os"]);
  const original = new Map(delivered);
  triggers.receive("server", {
    t: "index.patch",
    rev: 3,
    ops: [{
      op: "digest",
      id: entry.id,
      revision: 1,
      summary: { state: "ready", revision: 1, messageCount: 0 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    }],
  });
  assertEquals(
    retracted,
    [],
    "Metadata-only summaries must not retract a completion delivery",
  );
  assertEquals(
    [...delivered.keys()],
    ["toast", "badge", "os"],
    "The badge still counts this live completion identity",
  );
  for (const [channel, delivery] of original) {
    assertEquals(
      delivered.get(channel),
      delivery,
      "Digest changes must not replace or replay a delivery",
    );
  }
  await original.get("toast")!.invokeDefault();
  assertEquals(
    calls,
    ["session.open"],
    "The preserved toast action must still invoke its captured session",
  );
  triggers.receive("server", {
    t: "index.patch",
    rev: 4,
    ops: [{ op: "remove", id: entry.id }],
  });
  assertEquals([...delivered.keys()], []);
  assertEquals(retracted, ["toast", "badge", "os"]);
  await original.get("os")!.invokeDefault();
  assertEquals(
    calls,
    ["session.open"],
    "A genuinely retracted OS delivery cannot act later",
  );
  hub.stop();
});
