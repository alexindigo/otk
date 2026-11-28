// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { filterTiers, parseRunArgs } from "./run.ts";

Deno.test("commit runner parses worker, tier and keep-going controls", () => {
  assertEquals(
    parseRunArgs([
      "--changed-paths",
      "paths.nul",
      "--workers=8",
      "--tiers",
      "prepare,integration,collection,browser,integration-scale,scale",
      "--keep-going",
    ]),
    {
      workers: 8,
      tiers: [
        "prepare",
        "integration",
        "collection",
        "browser",
        "integration-scale",
        "scale",
      ],
      keepGoing: true,
    },
  );
  assertEquals(parseRunArgs([]), {
    workers: undefined,
    tiers: undefined,
    keepGoing: false,
  });
});

Deno.test("commit runner rejects invalid workers and unknown tiers", () => {
  for (const count of ["0", "-1", "NaN", "1.5", "8x"]) {
    assertThrows(() => parseRunArgs(["--workers=" + count]));
  }
  assertThrows(() => parseRunArgs(["--tiers", "browser,typo"]));
  assertThrows(() => parseRunArgs(["--tiers"]));
});

Deno.test("commit runner records valid tiers absent from the selection", () => {
  assertEquals(
    filterTiers([
      ["fmt", ["fmt", "--check"]],
      ["prepare", ["task", "test:prepare"]],
      ["browser", ["task", "test:e2e"]],
    ], ["prepare", "integration", "browser", "scale"]),
    {
      tiers: [
        ["prepare", ["task", "test:prepare"]],
        ["browser", ["task", "test:e2e"]],
      ],
      skipped: ["integration", "scale"],
    },
  );
});
