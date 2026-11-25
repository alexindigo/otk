// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { areas, validateCollection } from "../../scripts/tests/selection.ts";
import {
  qualificationAreas,
  qualificationTags,
} from "../../scripts/tests/qualification-areas.ts";

Deno.test("collection recognizes every registered area", () => {
  assert(areas.length > 0);
  for (const area of areas) validateCollection([[`@${area}`]], []);
  for (const area of [...areas, "scale"]) {
    assert(qualificationAreas.has(area));
    assertEquals(qualificationTags([`@${area}`]), [`@${area}`]);
  }
  assertEquals(
    qualificationTags([
      "@not-a-registered-area",
      "@terminal.not-an-area",
      "@scales",
    ]),
    [],
  );
  assertEquals(qualificationTags([]), []);
});
Deno.test("collection and migration share the registered area owner", async () => {
  const collection = await Deno.readTextFile("scripts/tests/collect.ts");
  const migration = await Deno.readTextFile("scripts/tests/migration-audit.ts");
  assertStringIncludes(
    collection,
    'import { qualificationTags } from "./qualification-areas.ts";',
  );
  assertStringIncludes(collection, "qualificationTags(row.tags)");
  assertStringIncludes(
    migration,
    'import { qualificationAreas as areas } from "./qualification-areas.ts";',
  );
});
