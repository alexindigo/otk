// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { metadata, terminalEvidence, terminalFacts } from "../metadata.ts";

Deno.test("V2 terminal clocks require a qualified outcome or a completed shell", () => {
  assertEquals(terminalEvidence(100, "unknown"), undefined);
  assertEquals(terminalEvidence(NaN, "failed"), undefined);
  assertEquals(terminalEvidence(100, "failed", 200), 200);
  assertEquals(terminalEvidence(100, "succeeded"), 100);
  assertEquals(terminalFacts(100, "failed"), {
    terminal: 100,
    outcome: "failed",
    terminalOrigin: "historical",
  });
  assertEquals(terminalFacts(100, "succeeded", 200), {
    terminal: 200,
    outcome: undefined,
    terminalOrigin: "historical",
  });
  assertEquals(terminalFacts(100, "failed", 100), {
    terminal: 100,
    outcome: "failed",
    terminalOrigin: "historical",
  });
  assertEquals(terminalFacts(100, "interrupted"), {
    terminal: 100,
    outcome: "interrupted",
    terminalOrigin: "historical",
  });
});

Deno.test("V2 helper execution survives a later shell exit without borrowing its clock", () => {
  const common = {
    id: "ses_child",
    parentID: "ses_parent",
    location: { directory: "/fixture" },
    projectID: "p",
    terminal: 200,
  };
  assertEquals(
    metadata({
      ...common,
      time: { created: 1, updated: 200, idle: 100 },
      outcome: "succeeded",
      runID: "idle-100",
      legacyAcknowledgement: { terminal: 100, runID: "idle-100" },
    }).activity,
    {
      terminal: 100,
      runID: "idle-100",
      legacyAcknowledgement: { terminal: 100, runID: "idle-100" },
      outcome: "succeeded",
      terminalOrigin: "historical",
    },
  );
  assertEquals(
    metadata({
      ...common,
      time: { created: 1, updated: 200 },
    }).activity,
    {},
  );
});
