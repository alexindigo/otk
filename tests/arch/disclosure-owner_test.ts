// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { property } from "./syntax.ts";

export function disclosureErrors(path: string, text: string): string[] {
  const source = new Source(text, path);
  const errors: string[] = [];
  const leaf = /\/(?:WorkLog|Reasoning|ToolOutput|UnknownPart)\.tsx$/.test(
    path,
  );
  for (const node of source.all) {
    if (
      node.type === "TSInterfaceDeclaration" &&
      node.id.name === "ToolPresentation" &&
      node.body.body.some((field) =>
        "key" in field && property(field.key) === "expanded"
      )
    ) {
      errors.push(
        "tool registrations declare categories, not expansion overrides",
      );
    }
    if (
      /\/components\/tools\//.test(path) && !path.endsWith("/ToolFrame.tsx") &&
      node.type === "ObjectProperty" && property(node.key) === "expanded"
    ) {
      errors.push("tool registrations cannot bypass category defaults");
    }
    if (
      leaf && node.type === "CallExpression" &&
      ["createSignal", "createStore"].includes(
        source.imported(node.callee)?.name ?? "",
      )
    ) {
      errors.push("inline disclosures borrow the transcript interaction owner");
    }
    if (
      path.endsWith("/MetadataPart.ts") && node.type === "ObjectProperty" &&
      property(node.key) === "hidden"
    ) {
      errors.push("bookkeeping must remain a visible record");
    }
  }
  return errors;
}

Deno.test("inline disclosures use one retained category/default owner", async () => {
  for (const [path, source] of await uiSources()) {
    if (!path.endsWith(".css")) {
      assertEquals(disclosureErrors(path, source), [], path);
    }
  }
});
Deno.test("disclosure gate rejects forced registration defaults and private state", () => {
  for (
    const [path, source] of [
      [
        "/registries/renderers.ts",
        "interface ToolPresentation { expanded?: boolean }",
      ],
      [
        "/components/tools/TaskTool.tsx",
        "const present = () => ({ expanded: true });",
      ],
      [
        "/components/tools/ToolOutput.tsx",
        'import { createSignal as state } from "solid-js"; const [open] = state(false);',
      ],
      [
        "/components/parts/MetadataPart.ts",
        "const present = () => ({ hidden: true });",
      ],
    ]
  ) assert(disclosureErrors(path, source).length > 0, path);
  assertEquals(
    disclosureErrors(
      "/components/tools/TaskTool.tsx",
      'const present = () => ({ category: "delegation" });',
    ),
    [],
  );
});
