// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { entityTimeValue, workingTimeValue } from "../message-presentation.ts";
import { elapsed } from "../format.ts";

Deno.test("working durations share wording across turn, entity and ledger facts", () => {
  for (const milliseconds of [0, 2500, 62000]) {
    assertEquals(
      entityTimeValue({
        known: true,
        value: milliseconds,
        final: true,
        active: false,
      }),
      workingTimeValue(milliseconds),
    );
    assertEquals(
      entityTimeValue({
        known: true,
        value: milliseconds,
        final: false,
        active: true,
      }),
      workingTimeValue(milliseconds, true),
    );
  }
  assertEquals(workingTimeValue(2500, false, "column"), {
    state: "known",
    time: elapsed(2500),
  });
  assertEquals(workingTimeValue(2500, true, "column"), {
    state: "counting",
    time: elapsed(2500),
  });
  assertEquals(workingTimeValue(undefined, true, "column"), {
    state: "counting",
  });
  assertEquals(workingTimeValue(49, true), { state: "counting" });
  assertEquals(workingTimeValue(50, true), {
    state: "counting",
    lead: "Worked for",
    time: elapsed(50),
  });
  assertEquals(entityTimeValue({ known: false, final: false, active: false }), {
    state: "counting",
  });
  assertEquals(
    entityTimeValue(
      { known: false, final: true, active: false },
      "Lost during migration",
    ),
    { state: "unknown", explanation: "Lost during migration" },
  );
});
