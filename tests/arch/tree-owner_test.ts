// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";

Deno.test("flat TreeNode paths share the nested junction and disclosure control", async () => {
  const text = await Deno.readTextFile("packages/ui/components/Tree.tsx");
  const node = text.slice(text.indexOf("export function TreeNode"));
  assert(node.includes("path?: readonly boolean[]"));
  const source = new Source(node);
  const elements = source.all.filter((n) => n.type === "JSXOpeningElement")
    .map((n) => source.name(n.name));
  assertEquals(elements.filter((name) => name === "Junction").length, 1);
  assertEquals(
    elements.filter((name) => name === "DisclosureToggle").length,
    1,
  );
  assertEquals(elements.filter((name) => name === "TreeRails").length, 1);
  assert(node.includes("<IconStemContext value={stem}>"));
});
