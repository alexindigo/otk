// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";

function controlErrors(path: string, text: string): string[] {
  if (path.endsWith(".css")) return [];
  const source = new Source(text, path), errors: string[] = [];
  for (const node of source.all) {
    if (
      node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" &&
      node.name.name === "select" && !path.endsWith("/Select.tsx")
    ) errors.push("native selects belong to Select");
    if (
      node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" &&
      node.name.name === "ChevronDownIcon" && path.includes("/features/prompt/")
    ) errors.push("picker accessories belong to ControlValue");
  }
  return errors;
}
Deno.test("remaining UI owners keep native select arrows, form width and overflow geometry shared", async () => {
  for (const [path, text] of await uiSources()) {
    assertEquals(controlErrors(path, text), [], path);
  }
  const read = (path: string) =>
    Deno.readTextFile(new URL(`../../packages/ui/${path}`, import.meta.url));
  const form = await read("components/Form.css"),
    rows = await read("components/list-presentation.ts"),
    tabs = await read("components/ProjectTabs.tsx"),
    editor = await read("components/prompt/Editor.css");
  assert(
    !/max-width\s*:/.test(form),
    "Form delegates its width to its surface",
  );
  assert(
    !/crumbs\.length\s*[<>=]|index\s*<\s*2|length\s*-\s*2/.test(rows),
    "No count folding",
  );
  assert(
    tabs.includes("<OverflowRow") && tabs.includes("required={required()}"),
  );
  assert(
    !/\b(?:width|height)\s*:[^;]*\b\d+(?:vh|vw)\b/.test(editor),
    "Editor content flows inside its dialog",
  );
});
Deno.test("remaining UI control ownership catches nested and caller-owned alternatives", () => {
  assert(
    controlErrors(
      "packages/ui/features/nested/Other.tsx",
      "<select><option>One</option></select>",
    ).length,
  );
  assert(
    controlErrors(
      "packages/ui/features/prompt/nested/Other.tsx",
      "<ChevronDownIcon/>",
    ).length,
  );
  assertEquals(
    controlErrors("packages/ui/components/Select.tsx", "<select/>"),
    [],
  );
  assertEquals(
    controlErrors("packages/ui/features/Other.tsx", "<Select/>"),
    [],
  );
});
