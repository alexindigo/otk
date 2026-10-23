// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { nodes, property } from "./syntax.ts";
import { resultBypasses } from "./bypasses.ts";
resultBypasses(errors);
export function errors(source: string): string[] {
  let parsed: Source;
  try {
    parsed = new Source(source);
  } catch {
    return ["tool result source must parse"];
  }
  const result: string[] = [];
  for (const node of parsed.all) {
    if (
      node.type === "JSXAttribute" && property(node.name) === "class" &&
      [...nodes(node)].some((child) =>
        parsed.string(child)?.split(/\s+/).includes("otk-tool-summary")
      )
    ) result.push("operation summaries belong to the header");
    if (
      node.type === "TemplateLiteral" && node.expressions.length &&
      node.quasis.slice(1).some((part) =>
        /^\s+(?:matches|entries|tool calls)\b/.test(part.value.cooked ?? "")
      )
    ) result.push("row counts use the shared label owner");
  }
  return result;
}
Deno.test("tool bodies own results, not repeated operation summaries or count inflection", async () => {
  const root = new URL("../../packages/ui/components/tools/", import.meta.url);
  for (const [path, source] of await uiSources()) {
    if (/\/components\/tools\/.*\.tsx?$/.test(path)) {
      assertEquals(errors(source), [], path);
    }
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
