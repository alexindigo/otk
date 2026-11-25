// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { select } from "../../scripts/tests/selection.ts";

Deno.test("terminal area selects its real integration files", () => {
  for (
    const paths of [["packages/ui/terminal/ghostty/core.ts"], [
      "packages/client/terminals.ts",
    ]]
  ) {
    const selection = select(paths, [], "HEAD");
    assert(selection.areas.includes("terminal"));
    for (
      const name of [
        "terminals_daemon_test.ts",
        "terminals_test.ts",
        "terminals_rejection_test.ts",
      ]
    ) {
      assert(selection.integration.includes("tests/integration/" + name));
    }
  }
});

Deno.test("terminal integration mapping permits broad, renamed and explicit selections", () => {
  assertEquals(select(["unknown.ts"], [], "HEAD").integration, ["*"]);
  assertEquals(
    select(
      ["old/unmapped.ts", "packages/ui/features/prompt/new.tsx"],
      [],
      "HEAD",
    ).integration,
    ["*"],
  );
  assert(
    select([], ["terminal"], "HEAD").integration.includes(
      "tests/integration/terminals_test.ts",
    ),
  );
});
