// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { PublicFailure } from "@otk/protocol";
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
