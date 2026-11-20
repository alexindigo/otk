// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  errorFeedback,
  FailurePresenter,
  notificationFailure,
  RequestFailure,
} from "../mod.ts";

Deno.test("failure presenter derives the complete contract and optional enrichment", () => {
  const presenter = new FailurePresenter();
  const failure = {
    code: "<html>/private/db SQL session.prompt",
    retry: "none" as const,
    diagnosticID: "opaque",
  };
  assertEquals(
    presenter.present(failure).failure?.reason,
    "OTK has no further details",
  );
  assertEquals(
    new RequestFailure(failure).message,
    "Request rejected",
  );
  presenter.register(
    "credentials",
    () => ({ kind: "error", text: "Check your username and password" }),
  );
  assertEquals(
    presenter.present({ ...failure, code: "credentials" }).failure?.reason,
    "Check your username and password",
  );
});

Deno.test("text-only error feedback gains shared failure facts without losing its action or identity", () => {
  let invoked = 0;
  const original = {
    kind: "error" as const,
    text: "The server refused the request",
    identity: "captured-operation",
    diagnosticID: "captured-diagnostic",
    action: { label: "Retry response", run: () => invoked++ },
  };
  const shown = errorFeedback(original, {
    actionLabel: "Loading response",
    target: { label: "Selected session" },
  })!;
  assertEquals(shown.failure?.reason, original.text);
  assertEquals(shown.failure?.heading, "Loading response failed");
  assertEquals(shown.failure?.target.label, "Selected session");
  assertEquals(shown.failure?.value.diagnosticID, "captured-diagnostic");
  assertEquals(shown.identity, original.identity);
  shown.action?.run();
  assertEquals(invoked, 1);
  assertEquals(errorFeedback(shown), shown);
});

Deno.test("legacy error notification titles remain outcome headings rather than failing twice", () => {
  const shown = notificationFailure({
    id: "legacy-error",
    kind: "error",
    title: "Sending prompt failed",
    body: "The provider quota has been reached",
    actions: [],
  });
  assertEquals(shown?.heading, "Sending prompt failed");
  assertEquals(shown?.reason, "The provider quota has been reached");
});

Deno.test("FP1 unsupported capability is one informational notice, not a failed action", () => {
  const presenter = createFailurePresenter();
  const notice = {
    code: "queued-messages.unsupported",
    retry: "none" as const,
    diagnosticID: "missing-inbox",
    facts: {
      actionLabel: "Loading queued messages",
      target: { sessionID: "opcv2-ses_one", label: "Session one" },
      reason: "Queued messages aren't available on this server.",
    },
  };
  for (let index = 0; index < 3; index++) {
    const value = presenter.present(notice, {
      surface: "session",
      view: notice.facts.target,
    });
    assertEquals(value.kind, "info");
    assertEquals(value.text, notice.facts.reason);
    assertEquals(value.action, undefined);
    assertEquals(value.failure?.tone, "info");
    assertEquals(value.failure?.count, 1);
    assertEquals(value.failure?.recovery, undefined);
    assertEquals(value.failure?.target.label, "Session one");
  }
});

Deno.test("FP1 informational contributions cannot downgrade an uncertain outcome", () => {
  const presenter = new FailurePresenter();
  presenter.register(
    "optional.feature",
    () => ({ kind: "info", text: "Not available" }),
  );
  const info = {
    code: "optional.feature",
    retry: "none" as const,
    diagnosticID: "info",
  };
  assertEquals(presenter.describe(info).kind, "info");
  assertEquals(presenter.describe(info).text, "Not available.");
  for (const outcome of ["unknown", "unavailable"] as const) {
    const value = presenter.describe({ ...info, facts: { outcome } });
    assertEquals(value.kind, "pending");
    assertEquals(value.failure?.tone, undefined);
  }
  const error = presenter.describe({ ...info, code: "other.failure" });
  assertEquals(error.kind, "error");
  assertEquals(error.failure?.tone, undefined);
});
