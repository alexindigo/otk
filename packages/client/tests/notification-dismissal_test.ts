// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type Note,
  type NoteDelivery,
  NotificationHub,
  requestIdle,
} from "@otk/client";

Deno.test("dismissal follows the request identity across republish and reconnect without invoking native work", () => {
  const delivered = new Map<string, NoteDelivery>();
  const calls: string[] = [];
  const hub = new NotificationHub(
    () => ({ channels: ["toast", "badge"] }),
    (command) => {
      calls.push(command);
      return Promise.resolve();
    },
    (error) => {
      throw error;
    },
  );
  for (const id of ["toast", "badge"]) {
    hub.registerChannel({
      id,
      available: () => true,
      deliver: (_note, delivery) => {
        delivered.set(id, delivery);
      },
      retract: () => {
        delivered.delete(id);
      },
    });
  }
  for (const kind of ["permission", "question"] as const) {
    const note: Note = {
      id: "server/session",
      sessionRef: { sidecar: "server", session: "session" },
      kind,
      title: "Needs input",
      dismissalKey: `${kind}/ask-1`,
      actions: [{ label: "Open", command: "session.open" }],
    };
    hub.publish(note);
    delivered.get("toast")!.dismiss();
    assertEquals([...delivered.keys()], ["badge"]);
    hub.refresh();
    hub.publish(note);
    assertEquals([...delivered.keys()], ["badge"]);
    hub.removeSidecar("server");
    hub.publish(note);
    assertEquals([...delivered.keys()], ["badge"]);
    hub.publish({ ...note, dismissalKey: `${kind}/ask-2` });
    assertEquals([...delivered.keys()], ["toast", "badge"]);
  }
  assertEquals(calls, []);
  hub.stop();
});

Deno.test("request age uses session activity, labels it honestly and describes stale resumption", () => {
  assertEquals(requestIdle(1, 12 * 86400_000 + 1), {
    label: "Session idle 12 days",
    resume: "Resumes work paused 12 days ago",
  });
  assertEquals(requestIdle(1, 86400_000 + 1), { label: "Session idle 1 day" });
  assertEquals(requestIdle(undefined, Date.now()), {
    label: "Session activity unavailable",
  });
});
