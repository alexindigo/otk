// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  failureNote,
  FailurePresenter,
  failureValue,
  notificationFailure,
  RequestFailure,
} from "@otk/client";
import type { PublicFailure } from "@otk/protocol";

Deno.test("retry and outcome policy never invent recovery advice", () => {
  for (const presenter of [new FailurePresenter(), createFailurePresenter()]) {
    for (const retry of ["none", "same-intent", "new-intent"] as const) {
      for (
        const outcome of [
          undefined,
          "rejected",
          "unknown",
          "unavailable",
        ] as const
      ) {
        const shown = presenter.describe({
          code: "extension.refused",
          retry,
          diagnosticID: "no-step",
          facts: {
            actionLabel: "Saving work",
            reason: "The service refused the change",
            outcome,
          },
        });
        assertEquals(shown.failure?.recovery, undefined);
        assertEquals(
          shown.text,
          `${shown.failure!.heading} for OTK: The service refused the change.`,
        );
      }
    }
  }
});

Deno.test("owner-authored recovery survives inline and notification projection without defaults", () => {
  const failure: PublicFailure = {
    code: "extension.cause",
    retry: "none",
    diagnosticID: "specific-step",
    facts: {
      actionLabel: "Reading artifact",
      reason: "The artifact needs access",
      recovery: "Grant read access to the artifact, then open it again",
    },
  };
  const cause = new RequestFailure(failure);
  const inline = failureValue(cause);
  if (!inline) throw new Error("Missing failure");
  assertEquals(inline.failure?.recovery, failure.facts!.recovery);
  assertEquals(
    notificationFailure(failureNote(cause)!)?.recovery,
    failure.facts!.recovery,
  );
  assertEquals(
    inline.text,
    "Reading artifact failed for OTK: The artifact needs access. Grant read access to the artifact, then open it again.",
  );
});

Deno.test("actionable authentication reason does not gain a redundant recovery sentence", () => {
  const shown = createFailurePresenter().describe({
    code: "auth.credentials",
    retry: "new-intent",
    diagnosticID: "credentials",
    facts: { action: "bootstrap.login", target: { label: "Remote agent" } },
  });
  assertEquals(shown.failure?.recovery, undefined);
  assertEquals(
    shown.text,
    "Signing in failed for Remote agent: Check your username and password.",
  );
});

Deno.test("empty recovery is absent and existing sentence punctuation stays intact", () => {
  for (const recovery of [undefined, "", "  "]) {
    const shown = createFailurePresenter().describe({
      code: "extension.cause",
      retry: "new-intent",
      diagnosticID: "empty-step",
      facts: {
        actionLabel: "Saving work",
        reason: "The service refused the change.",
        recovery,
      },
    });
    assertEquals(shown.failure?.recovery, undefined);
    assertEquals(
      shown.text,
      "Saving work failed for OTK: The service refused the change.",
    );
  }
});
