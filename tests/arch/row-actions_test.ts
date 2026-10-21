// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

function tabErrors(source: string): string[] {
  const tabs = source.slice(
    source.indexOf('class="otk-task-list"'),
    source.indexOf('class="otk-icon-button otk-task-new"'),
  );
  return /<(?:Menu|Popover)\b|⋯|···|otk-tab-actions/.test(tabs)
    ? ["tabs have no menu presentation"]
    : [];
}
function rowErrors(css: string): string[] {
  const errors: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      /\.otk-project-(?:row|open|content|trailing|visit|menu)\b/.test(
        selector,
      ) &&
      /\bposition\s*:|(?:^|;)\s*(?:top|left|right|bottom|inset)(?:-[\w-]+)?\s*:/
        .test(body)
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
