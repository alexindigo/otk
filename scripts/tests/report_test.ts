// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { outcome, validateQuarantine } from "./report.ts";
Deno.test("FLAKE1: five visible categories never round flaky/not-run up to green", () => {
  assertEquals(outcome(["passed"]).category, "first-pass");
  assertEquals(outcome(["failed", "passed"]).exit, 1);
  assertEquals(outcome(["failed", "passed"]).category, "flaky");
  assertEquals(outcome(["failed"]).category, "failed");
  assertEquals(outcome([]).category, "not-run");
  assertEquals(
    outcome(["passed"], true).label,
    "passed; active quarantine metadata",
  );
});
Deno.test("FLAKE1: owned, known, unique and unexpired quarantine only", () => {
  const q = {
    id: "stable",
    project: "oc-1.18.34",
    reason: "diagnosed",
    failureClass: "test race",
    issue: "OTK-1",
    owner: "maintainer",
    expiry: "2099-01-01T00:00:00Z",
  };
  const collection = [{ id: q.id, project: q.project }];
  validateQuarantine([], collection);
  validateQuarantine([q], collection);
  assertThrows(() => validateQuarantine([q, q], collection));
  assertThrows(() => validateQuarantine([q], []));
  assertThrows(() =>
    validateQuarantine([{ ...q, expiry: "2000-01-01T00:00:00Z" }], collection)
  );
  assertThrows(() => validateQuarantine([{ ...q, owner: "" }], collection));
});
