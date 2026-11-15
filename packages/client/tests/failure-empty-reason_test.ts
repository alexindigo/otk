// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createFailurePresenter,
  failureNote,
  FailurePresenter,
  failureValue,
  GENERIC_FAILURE_REASON,
  notificationFailure,
  RequestFailure,
} from "@otk/client";

for (const reason of ["", "   ", "\t\n"]) {
  Deno.test(`empty failure reason ${JSON.stringify(reason)} uses honest generic wording without changing facts`, () => {
    const facts = { reason },
      shown = new FailurePresenter().describe({
        code: "fixture.empty",
        retry: "none",
        diagnosticID: "empty",
        facts,
      });
    assertEquals(shown.failure?.reason, GENERIC_FAILURE_REASON);
    assertEquals(shown.failure?.generic, true);
    assertEquals(shown.failure?.value.facts?.reason, reason);
    assertEquals(facts.reason, reason);
  });
  Deno.test(`empty failure reason ${JSON.stringify(reason)} does not mask feature-owned wording`, () => {
    const shown = createFailurePresenter().describe({
      code: "session.busy",
      retry: "none",
      diagnosticID: "enriched",
      facts: { reason },
    });
    assertEquals(
      shown.failure?.reason,
      "This session is working. Try again when it finishes",
    );
    assertEquals(shown.failure?.generic, undefined);
    assertEquals(shown.failure?.value.facts?.reason, reason);
  });
}

Deno.test("blank feature enrichment is absent wording, not an empty reason", () => {
  const presenter = new FailurePresenter();
  presenter.register("fixture.blank", () => ({ kind: "error", text: " \t " }));
  const shown = presenter.describe({
    code: "fixture.blank",
    retry: "none",
    diagnosticID: "blank-enrichment",
  });
  assertEquals(shown.failure?.reason, GENERIC_FAILURE_REASON);
  assertEquals(shown.failure?.generic, true);
});

Deno.test("nonempty public reason retains exact whitespace and source facts", () => {
  const reason = "  Exact native explanation.\n";
  const shown = new FailurePresenter().describe({
    code: "fixture.exact",
    retry: "none",
    diagnosticID: "exact",
    facts: { reason },
  });
  assertEquals(shown.failure?.reason, reason);
  assertEquals(shown.failure?.value.facts?.reason, reason);
  assertEquals(shown.failure?.generic, undefined);
});

Deno.test("empty reason fallback reaches both inline and notification consumers", () => {
  const cause = new RequestFailure({
    code: "fixture.empty",
    retry: "none",
    diagnosticID: "consumer-empty",
    facts: { reason: "" },
  });
  const inline = failureValue(cause);
  assert(inline);
  assertEquals(inline.failure?.reason, GENERIC_FAILURE_REASON);
  assert(inline.text.includes(GENERIC_FAILURE_REASON));
  const note = failureNote(cause)!;
  assertEquals(notificationFailure(note)?.reason, GENERIC_FAILURE_REASON);
  assert(note.title.includes(GENERIC_FAILURE_REASON));
});
