// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";

function disabledCommands(text: string): number {
  const source = new Source(text, "Palette.tsx");
  return source.all.filter((node) =>
    node.type === "JSXOpeningElement" &&
    (source.attr(node, "disabled") !== undefined ||
      source.attr(node, "aria-disabled") !== undefined)
  ).length;
}
Deno.test("palette command controls never render disabled availability states", async () => {
  assertEquals(
    disabledCommands(
      await Deno.readTextFile("packages/ui/components/Palette.tsx"),
    ),
    0,
  );
  assertEquals(
    disabledCommands("<button disabled={!row().enabled}>Command</button>"),
    1,
  );
  assertEquals(
    disabledCommands('<button aria-disabled="true">Command</button>'),
    1,
  );
  assertEquals(disabledCommands("<button>Command</button>"), 0);
});
