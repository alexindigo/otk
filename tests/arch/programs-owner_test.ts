// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertFalse, assertMatch } from "@std/assert";
import { productionSources } from "./analysis.ts";

Deno.test("D83/D84: only ProjectPrograms writes membership; the client borrows it without a lamp calculation", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
  const known = [
    "application.ts",
    "core/features/inbox.ts",
    "core/features/programs.ts",
  ];
  const references: string[] = [];
  for (const [path, source] of await productionSources()) {
    if (
      !path.startsWith("packages/store/") && /\bProgramStore\b/.test(source)
    ) {
      references.push(path);
    }
    if (!path.startsWith("packages/store/")) {
      assertFalse(
        /\b(?:program_members|program_settings)\b/.test(source),
        path,
      );
    }
    if (path.startsWith("packages/client/") && /\bprogram\b/.test(source)) {
      assertFalse(/\brollupStatus\b/.test(source), path);
    }
  }
  assertEquals(references.toSorted(), known);
  const inbox = await read("core/features/inbox.ts");
  assertFalse(
    /stores\.programs\.(?:create|ensureAuto|rename|remove|dismiss|move|assign|unassign|forget|setAuto)\(/
      .test(inbox),
  );
  const resources = await read("packages/client/server-resources.ts");
  assertMatch(resources, /replica\.member\(slot\.id\)/);
  const replica = await read("packages/client/programs.ts");
  assertMatch(replica, /Object\.entries\(next\.members\)/);
});
