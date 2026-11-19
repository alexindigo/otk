// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { uiSources } from "./analysis.ts";
import { surfaceErrors } from "./surface-policy.ts";
import { typographyErrors } from "./styles.ts";

Deno.test("project chip stays inside the shared overlay and typography contracts", async () => {
  const files = new Map(
    [...(await uiSources())].map((
      [path, source],
    ) => [path.replace(/^packages\/ui\//, ""), source]),
  );
  assertEquals(
    surfaceErrors(files).filter((error) =>
      /^(?:components\/ProjectChip|features\/project-chip)/.test(error)
    ),
    [],
  );
  assertEquals(typographyErrors(files.get("components/ProjectChip.css")!), []);
});
