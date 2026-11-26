// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { rules } from "./styles.ts";

function rowErrors(text: string, row = "ListRow"): string[] {
  const source = new Source(text);
  const shared = source.all.some((node) =>
    node.type === "JSXOpeningElement" && source.name(node.name) === row
  );
  const copied = source.all.some((node) =>
    node.type === "CallExpression" && source.name(node.callee) === "selection"
  );
  return [
    ...(!shared ? ["missing shared list-row frame"] : []),
    ...(copied ? ["consumer owns row selection"] : []),
  ];
}
Deno.test("Timeline and both sidebars delegate to SidebarRow", async () => {
  for (
    const [name, row] of [["ProjectSessions", "SidebarRow"], [
      "ProjectInbox",
      "SidebarRow",
    ], ["Timeline", "SidebarRow"]]
  ) {
    const base = `packages/ui/components/${name}`;
    assertEquals(
      rowErrors(await Deno.readTextFile(`${base}.tsx`), row),
      [],
      name,
    );
    for (
      const { selector, declarations } of rules(
        await Deno.readTextFile(`${base}.css`),
      )
    ) {
      if (!/\.otk-(?:session|timeline)-row/.test(selector)) continue;
      assert(
        ![...declarations.keys()].some((key) =>
          /^(?:height|min-height|block-size|min-block-size|padding)(?:-|$)/
            .test(
              key,
            )
        ),
        `${name}: shared row geometry belongs to ${row}`,
      );
    }
  }
  assertEquals(rowErrors("<ListRow selected={current}>{label}</ListRow>"), []);
  assert(
    rowErrors(
      '<button {...selection({selected,kind:"current"})}>{label}</button>',
    ).length > 0,
  );
  assert(
    rowErrors(
      '<ListRow {...selection({selected,kind:"current"})}>{label}</ListRow>',
    ).length > 0,
  );
});
