// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  failureNote,
  type Note,
  notificationFailure,
  NotificationHub,
} from "@otk/client";

function reactive<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      const item = Reflect.get(target, key, receiver);
      return item && typeof item === "object" ? reactive(item) : item;
    },
  });
}

Deno.test("reactive failure feedback publishes cloneable facts without a framework-specific hub", () => {
  const owner = createFailurePresenter();
  const feedback = owner.present({
    code: "fixture.unregistered",
    retry: "none",
    diagnosticID: "reactive-failure",
    facts: {
      action: "permission.list",
      target: {
        sidecarId: "remote",
        sessionID: "tstv1-helper",
        label: "Asking helper",
      },
      reason: "The permission lookup was refused",
      status: 403,
    },
  });
  const note = failureNote(reactive(feedback))!;
  const copied = structuredClone(note);
  assertEquals(notificationFailure(copied)?.value, feedback.failure!.value);
  assertEquals(notificationFailure(copied)?.target.label, "Asking helper");
  assertEquals(
    notificationFailure(copied)?.reason,
    "The permission lookup was refused (HTTP 403)",
  );
  const delivered: Note[] = [];
  const hub = new NotificationHub(
    () => ({ channels: ["fixture"] }),
    () => Promise.resolve(),
    (cause) => {
      throw cause;
    },
  );
  hub.registerChannel({
    id: "fixture",
    available: () => true,
    deliver: (note) => {
      delivered.push(note);
    },
    retract() {},
  });
  try {
    hub.publish(note);
    assertEquals(delivered.length, 1);
    assertEquals(
      notificationFailure(delivered[0])?.value,
      feedback.failure!.value,
    );
  } finally {
    hub.stop();
  }
});
