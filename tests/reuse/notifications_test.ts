// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  CommandHub,
  type Note,
  type NoteDelivery,
  NotificationHub,
} from "@otk/client";
Deno.test("plain Deno notification consumer routes actionable jobs through public command IDs without a browser", async () => {
  const jobs = new Map([["one", "waiting"], ["two", "waiting"]]);
  const commands = new CommandHub();
  commands.register({
    id: "job.accept",
    title: "Accept job",
    category: "Jobs",
    run: (_ctx, id: string) => jobs.set(id, "accepted"),
  });
  let row: { note: Note; port: NoteDelivery } | undefined;
  const hub = new NotificationHub(
    () => ({ channels: ["console"] }),
    (id, args) => commands.run(id, args),
    (error) => {
      throw error;
    },
  );
  const release = hub.registerChannel({
    id: "console",
    available: () => true,
    deliver(note, port) {
      row = { note, port };
    },
    retract() {
      row = undefined;
    },
  });
  hub.publish({
    id: "job",
    kind: "info",
    title: "Job one",
    actions: [{ label: "Accept", command: "job.accept", args: "one" }],
  });
  const old = row!;
  hub.publish({
    id: "job",
    kind: "info",
    title: "Job two",
    actions: [{ label: "Accept", command: "job.accept", args: "two" }],
  });
  await old.port.invoke(old.note.actions[0]);
  old.port.dismiss();
  await row!.port.invoke(row!.note.actions[0]);
  assertEquals([...jobs], [["one", "waiting"], ["two", "accepted"]]);
  row!.port.dismiss();
  assertEquals(row, undefined);
  release();
  hub.stop();
});
