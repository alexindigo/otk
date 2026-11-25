// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createPrimaryAction,
  createSessionDelivery,
  createSubmissionIntent,
  FailurePresenter,
} from "@otk/client";

for (const outcome of ["disabled", "refused", "sent"] as const) {
  Deno.test(`Send ends exactly once as ${outcome}, never successful silence`, async () => {
    const target = { sidecarId: "local", sessionID: "opcv2-ses_send" };
    let reason = outcome === "disabled" ? "Reconnect to send" : undefined;
    let dispatched = 0;
    const delivery = createSessionDelivery({
      target,
      title: () => "Captured session",
      transcript: () => undefined,
      clock: { set: () => 0, clear: () => {} },
    });
    const intent = createSubmissionIntent<string>({
      capture: (value) => value,
      presenter: new FailurePresenter(),
      target: () => ({ ...target, label: "Captured session" }),
      unavailable: () => reason,
      recovery: () => "Reconnect, then send the retained draft",
    });
    const primary = createPrimaryAction({
      label: () => "Send",
      unavailable: () => reason,
      pending: () => intent.state.pending,
      pendingReason: "Sending",
      run: () =>
        intent.submit(() => {
          if (outcome === "refused") reason = "Reconnect to send";
          return Promise.resolve("retained draft");
        }, async () => {
          await delivery.send(() => {
            dispatched++;
            return Promise.resolve({
              messageID: "native-user-id",
              state: "queued",
            });
          });
        }),
    });
    const before = primary.state;
    try {
      await primary.invoke().catch(() => {});
      const refused = intent.state.feedback?.failure;
      const observed = {
        disabled: !before.available && before.reason !== undefined,
        refused: !!refused?.action && !!refused.value.facts?.target?.label &&
          !!refused.reason && !!refused.recovery,
        sent: delivery.state.receipts.some((receipt) =>
          receipt.messageID === "native-user-id" && receipt.phase === "queued"
        ),
      };
      assertEquals(Object.values(observed).filter(Boolean).length, 1);
      assertEquals(observed[outcome], true);
      assertEquals(dispatched, outcome === "sent" ? 1 : 0);
    } finally {
      delivery.stop();
    }
  });
}
