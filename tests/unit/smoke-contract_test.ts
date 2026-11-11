// SPDX-License-Identifier: LGPL-3.0-only
import { assertThrows } from "@std/assert";
import { validateSmoke } from "../../scripts/tests/selection.ts";

Deno.test("collection keeps every required smoke contract with extra journeys", () => {
  const required = ["native-prompt", "attention", "navigation", "preferences"]
    .map((id) => ["@smoke", `@smoke.${id}`]);
  for (const version of ["2.2.6", "1.19.3"]) {
    const project = `oc-${version}`;
    validateSmoke([...required, ["@smoke", "@composer"]], project);
    assertThrows(() => validateSmoke(required.slice(1), project));
    assertThrows(() => validateSmoke([...required, required[0]], project));
    assertThrows(() => validateSmoke([], project));
  }
});
