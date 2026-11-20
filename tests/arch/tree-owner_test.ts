// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";

export function nestingErrors(path: string, text: string): string[] {
  if (path.endsWith("/Tree.css") || path.endsWith("/Tree.tsx")) return [];
  return [
    /border-(?:inline-start|inline-end|left|right)\s*:\s*[^;]*dotted/.test(
      text,
    ),
    /otk-(?:project-branch|session-branch|session-indent|record-list-connector|work-chevron|reasoning-chevron|native-chevron)/
      .test(text),
    text.includes("M4 0v10a5"),
    text.includes("∟"),
  ].flatMap((bad, index) =>
    bad ? [`${path}: duplicate nesting paint ${index}`] : []
  );
}
Deno.test("one Tree component owns every nesting rail and junction", async () => {
  const failures: string[] = [];
  for (const [path, text] of await uiSources()) {
    if (path.includes("/components/")) {
      failures.push(...nestingErrors(path, text));
    }
  }
  assertEquals(failures, []);
});
Deno.test("tree architecture guard rejects copied rails and elbows", () => {
  for (
    const source of [
      ".branch { border-inline-start: 1px dotted var(--line); }",
      '<span class="otk-project-branch"/>',
      '<path d="M4 0v10a5"/>',
      'const elbow = "∟";',
    ]
  ) assert(nestingErrors("/components/Invented.tsx", source).length);
});
Deno.test("nested and virtual trees construct one shared junction cell", async () => {
  const source = new Source(
    await Deno.readTextFile(
      new URL("../../packages/ui/components/Tree.tsx", import.meta.url),
    ),
  );
  assertEquals(
    source.all.filter((node) =>
      node.type === "StringLiteral" && node.value === "otk-tree-junction"
    ).length,
    1,
  );
});
