// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { PublicFailure } from "@otk/protocol";
import { createFailurePresenter, sessionFailure } from "../failure-features.ts";

const value: PublicFailure = {
  code: "native.rejected",
  retry: "new-intent",
  diagnosticID: "original",
  facts: {
    action: "session.prompt",
    reason: "Config path: opencode.config.ts",
    status: 400,
    outcome: "rejected",
    target: { sessionID: "opcv1-ses_one", label: "One" },
    record: {
      messageID: "record-one",
      label: "Not sent - see the error above",
    },
  },
};
Deno.test("FP1 gives an owned failure one full record presentation and short references everywhere else", () => {
  const presenter = createFailurePresenter();
  const feedback = presenter.describe(value);
  assertEquals(feedback.text, "Not sent - see the error above");
  assertEquals(feedback.failure?.reference?.messageID, "record-one");
  const full = presenter.describe(value, "record");
  assertEquals(full.failure?.reference, undefined);
  assertEquals(
    full.failure?.reason,
    "Config path: opencode.config.ts (HTTP 400)",
  );
  assertEquals(full.failure?.value.diagnosticID, "original");
  assertEquals(
    presenter.group(value).failure?.reference?.messageID,
    "record-one",
  );
  assertEquals(
    sessionFailure(
      {
        id: "event",
        source: "event",
        message: value.facts!.reason!,
        failure: value,
      },
      value.facts!.reason,
      {},
    ),
    undefined,
  );
  assertEquals(
    presenter.describe({
      ...value,
      facts: { ...value.facts, record: undefined },
    }).failure?.reference,
    undefined,
  );
});
