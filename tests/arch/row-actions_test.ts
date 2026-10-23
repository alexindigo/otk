// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { nodes } from "./syntax.ts";
import { rules } from "./styles.ts";
import { tabBypasses } from "./bypasses.ts";
tabBypasses(tabErrors);

export function tabErrors(source: string): string[] {
  let parsed: Source;
  try {
    parsed = new Source(source);
  } catch {
    return ["tab chrome must parse"];
  }
  const lists = parsed.all.filter((node) =>
    node.type === "JSXElement" &&
    parsed.string(parsed.attr(node.openingElement, "role")) === "tablist"
  );
  if (lists.length !== 1) {
    return ["tab chrome requires one unambiguous tablist"];
  }
  return [...nodes(lists[0])].some((node) =>
      node.type === "JSXOpeningElement" &&
        ["Menu", "Popover", "CommandMenu"].includes(
          parsed.name(node.name) ?? "",
        ) ||
      node.type === "JSXText" && /⋯|···/.test(node.value) ||
      node.type === "StringLiteral" &&
        node.value.split(/\s+/).includes("otk-tab-actions")
    )
    ? ["tabs have no menu presentation"]
    : [];
}
function rowErrors(css: string): string[] {
  const errors: string[] = [];
  for (const { selector, declarations } of rules(css)) {
    if (
      /\.otk-project-(?:row|open|content|trailing|visit|menu)\b/.test(
        selector,
      ) &&
      [...declarations.keys()].some((prop) =>
        /^(?:position|top|left|right|bottom|inset)(?:-|$)/.test(prop)
      )
    ) {
      errors.push("project row content stays in flow");
    }
  }
  return errors;
}
Deno.test("tab chrome has no menus and project row actions share an in-flow trailing cell", async () => {
  const ui = new URL("../../packages/ui/", import.meta.url);
  const tabs = await Deno.readTextFile(
    new URL("components/ProjectTabs.tsx", ui),
  );
  assertEquals(tabErrors(tabs), []);
  for (
    const name of [
      "task.pin",
      "task.rename",
      "task.reorder",
      "task.close",
    ]
  ) {
    assert(
      tabs.includes(`ownedAction("${name}"`),
      `${name}: keep the command owner`,
    );
  }
  assert(/ownedCommand\([\s\S]*?id: "task.add"/.test(tabs));
  assert(!tabs.includes("function AddToTask"));
  const row = await Deno.readTextFile(
    new URL("components/ProjectInbox.tsx", ui),
  );
  assert(
    /class="otk-project-trailing"[\s\S]*?<time\b[\s\S]*?<CommandMenu\b[\s\S]*?\/\>\s*<\/div>/
      .test(row),
  );
  assertEquals(
    rowErrors(
      await Deno.readTextFile(new URL("components/ProjectInbox.css", ui)),
    ),
    [],
  );
  const surfaces = await Deno.readTextFile(
    new URL("surfaces_test.ts", import.meta.url),
  );
  assert(!surfaces.includes("components/ProjectInbox.css:.otk-project-menu"));
  assert(
    tabErrors(
      'class="otk-task-list"><Menu trigger="⋯" /></div><button class="otk-icon-button otk-task-new"',
    ).length > 0,
  );
  for (
    const invalid of [
      ".otk-project-row { position: relative; }",
      ".otk-project-menu { position: absolute; right: 4px; }",
      ".otk-project-trailing { inset-inline-end: 4px; }",
    ]
  ) {
    assert(rowErrors(invalid).length > 0, invalid);
  }
  assertEquals(
    rowErrors(".otk-project-trailing { display: grid; align-items: center; }"),
    [],
  );
});
