// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type PublicFailure, sessionErrorMessage } from "@otk/protocol";
import { SessionErrors } from "../session-errors.ts";

Deno.test("recovered origin enriches only its existing active diagnostic and preserves provenance and retirement", () => {
  let published = 0;
  const owner = new SessionErrors(() => {
    published++;
  });
  const failure: PublicFailure = {
    code: "native.execution",
    retry: "none",
    diagnosticID: "same",
    facts: {
      reason: "Original cause",
      record: { messageID: "record", label: "See above" },
    },
  };
  const other = owner.begin("s", undefined, "http-other");
  owner.http(other, {
    message: "Independent HTTP failure",
    failure: { ...failure, diagnosticID: "other" },
  });
  owner.native("s", { message: "Original cause", failure }, "evt-native");
  const before = owner.snapshot("s"),
    enriched = {
      ...failure,
      facts: {
        ...failure.facts,
        origin: "composer" as const,
        reason: "Do not replace the cause",
      },
    };
  owner.enrich("s", enriched);
  const after = owner.snapshot("s");
  assertEquals(
    after.observations,
    before.observations.map((observation) =>
      observation.failure?.diagnosticID === "same"
        ? {
          ...observation,
          failure: {
            ...failure,
            facts: { ...failure.facts, origin: "composer" },
          },
        }
        : observation
    ),
  );
  assertEquals(after.observations[1].eventID, "evt-native");
  const count = published;
  owner.enrich("s", {
    ...enriched,
    facts: { ...enriched.facts, origin: "api" },
  });
  assertEquals(published, count, "An existing origin is not reassigned");
  const late = owner.begin("s", undefined, "late");
  owner.http(late, { message: "Original cause", failure });
  owner.clear("s");
  const cleared = owner.snapshot("s");
  owner.enrich("s", enriched);
  assertEquals(owner.snapshot("s"), cleared);
  owner.remove("s");
  const retired = published;
  owner.enrich("s", enriched);
  assertEquals(published, retired);
  assertEquals(owner.snapshot("s").observations, []);
});

for (const source of ["http", "event"] as const) {
  Deno.test(`${source} composer observations retain their record without setting session-level error text`, () => {
    const owner = new SessionErrors(() => {});
    const failure: PublicFailure = {
      code: "command",
      retry: "new-intent",
      diagnosticID: "composer-rejected",
      facts: {
        origin: "composer",
        reason: "That command is no longer available",
        record: { messageID: "retained-rejection", label: "See above" },
      },
    };
    const current = owner.begin("s", "command", "composer-call");
    if (source === "http") {
      owner.http(current, {
        message: "The operation has not completed",
        status: 400,
        failure,
      });
    } else {owner.native(
        "s",
        { message: "Composer execution failed", failure },
        "native-composer",
      );}
    const retained = owner.snapshot("s");
    assertEquals(retained.observations[0].failure, failure);
    assertEquals(sessionErrorMessage(retained), undefined);
    owner.native(
      "s",
      { message: "Independent native failure" },
      "independent-native",
    );
    assertEquals(
      sessionErrorMessage(owner.snapshot("s")),
      "Independent native failure",
    );
    owner.settled(current);
  });
}

Deno.test("late composer origin enrichment changes only the session-level projection, not the retained diagnostic", () => {
  const owner = new SessionErrors(() => {});
  const failure: PublicFailure = {
    code: "command",
    retry: "new-intent",
    diagnosticID: "retained",
    facts: { record: { messageID: "retained", label: "See above" } },
  };
  const current = owner.begin("s", "command", "request");
  owner.http(current, { message: "Rejected command", failure });
  assertEquals(sessionErrorMessage(owner.snapshot("s")), "Rejected command");
  owner.enrich("s", {
    ...failure,
    facts: { ...failure.facts, origin: "composer" },
  });
  assertEquals(owner.snapshot("s").observations.length, 1);
  assertEquals(
    owner.snapshot("s").observations[0].failure?.facts?.record,
    failure.facts!.record,
  );
  assertEquals(sessionErrorMessage(owner.snapshot("s")), undefined);
  const next = owner.begin("s", "command", "api-request");
  owner.http(next, {
    message: "API command failed",
    failure: { ...failure, facts: { ...failure.facts, origin: "api" } },
  });
  assertEquals(sessionErrorMessage(owner.snapshot("s")), "API command failed");
});
