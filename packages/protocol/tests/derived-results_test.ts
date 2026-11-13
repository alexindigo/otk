// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { knownDerived } from "../digest.ts";

Deno.test("derived witnesses change with value, coverage or source, never refresh observation", () => {
  const first = knownDerived({ count: 3 }, "source-a", 1, false);
  assertStrictEquals(
    knownDerived({ count: 3 }, "source-a", 99, false, first),
    first,
  );
  const covered = knownDerived({ count: 3 }, "source-a", 99, true, first);
  assertEquals(covered.state === "known" && covered.witness.revision, 2);
  const replacement = knownDerived(
    { count: 3 },
    "source-b",
    100,
    true,
    covered,
  );
  assertEquals(
    replacement.state === "known" && replacement.witness.revision,
    3,
  );
  const corrected = knownDerived(
    { count: 0 },
    "source-b",
    101,
    true,
    replacement,
  );
  assertEquals(corrected.state === "known" && corrected.witness.revision, 4);
});
