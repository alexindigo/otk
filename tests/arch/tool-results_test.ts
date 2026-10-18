// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
function errors(source: string): string[] {
  return [
    ...(/class=["'][^"']*\botk-tool-summary\b/.test(source)
      ? ["operation summaries belong to the header"]
      : []),
    ...(/\$\{[^}]+\}\s+(?:matches|entries|tool calls)\b/.test(source)
      ? ["row counts use the shared label owner"]
      : []),
  ];
}
Deno.test("tool bodies own results, not repeated operation summaries or count inflection", async () => {
  const root = new URL("../../packages/ui/components/tools/", import.meta.url);
  for await (const file of Deno.readDir(root)) {
    if (!file.name.endsWith(".tsx")) continue;
    assertEquals(
      errors(await Deno.readTextFile(new URL(file.name, root))),
      [],
      file.name,
    );
  }
  const output = await Deno.readTextFile(new URL("ToolOutput.tsx", root));
  assert(
    !/call\.tool|<content>|<skill_content|<task_result>|Found \\d/.test(output),
  );
  for (
    const source of [
      '<div class="otk-tool-summary">Read {call.path}</div>',
      "`${call.matches} matches`",
      "`${call.toolCount} tool calls`",
    ]
  ) assert(errors(source).length > 0);
});
