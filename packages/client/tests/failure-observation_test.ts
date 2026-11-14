// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  failureNote,
  NotificationHub,
  RequestFailure,
  sessionFailure,
} from "@otk/client";

Deno.test("session observation projection keeps routing and withholds credential-bearing prose", () => {
  const secret = "do-not-publish-this-value";
  const projected = sessionFailure(
    {
      id: "native-observation",
      source: "event",
      message: `Authorization: Bearer ${secret}`,
    },
    undefined,
    {
      action: "Running session",
      target: {
        sidecarId: "remote",
        sessionID: "tstv1-session",
        label: "Fixture",
      },
    },
  )!;
  assert(!JSON.stringify(projected).includes(secret));
  assertEquals(
    createFailurePresenter().present(projected).failure?.target.href,
    "#/remote/tstv1-session",
  );
});

Deno.test("remounting a legacy session error cannot invent a new occurrence", () => {
  const owner = createFailurePresenter();
  for (let n = 0; n < 3; n++) {
    const value = sessionFailure(undefined, "Native failure", {
      action: "Running session",
      target: { sidecarId: "remote", sessionID: "tstv1-session" },
    })!;
    assertEquals(owner.present(value).failure?.count, 1);
  }
});

Deno.test("uncertain observations are not terminal failure notifications", () => {
  for (const outcome of ["unknown", "unavailable"] as const) {
    const note = failureNote(
      new RequestFailure({
        code: "native.unknown",
        retry: "none",
        diagnosticID: outcome,
        facts: { outcome, reason: "The native outcome is not yet known" },
      }),
    )!;
    assertEquals(note.kind, "info");
    assert(note.title.startsWith("Checking whether"));
  }
});

Deno.test("failure dismissal survives replay and viewing, while a new occurrence is delivered", () => {
  let deliveries = 0;
  let dismiss = () => {};
  const hub = new NotificationHub(
    () => ({ channels: ["toast"] }),
    () => Promise.resolve(),
    () => {},
  );
  hub.registerChannel({
    id: "toast",
    available: () => true,
    retract() {},
    deliver(_note, delivery) {
      deliveries++;
      dismiss = delivery.dismiss;
    },
  });
  const failure = (id: string) =>
    failureNote(
      new RequestFailure({
        code: "consumer.replay",
        retry: "none",
        diagnosticID: id,
        facts: {
          action: "session.rename",
          target: { sidecarId: "replay", sessionID: "tstv1-session" },
          reason: "The session was not found",
        },
      }),
    )!;
  const first = hub.publish(failure("first"));
  hub.viewed("replay", "tstv1-session");
  assert(hub.current(first));
  dismiss();
  hub.publish(failure("first"));
  assertEquals(deliveries, 1);
  hub.publish(failure("second"));
  assertEquals(deliveries, 2);
  hub.stop();
});
