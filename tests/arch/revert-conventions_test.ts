// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { rules } from "./styles.ts";

export function revertLayoutErrors(css: string): string[] {
  return rules(css).filter(({ selector, declarations }) =>
    /(?:revert|rolled-back|saved-branch|composer-notice)/.test(selector) &&
    declarations.get("position") === "absolute"
  ).map(({ selector }) => selector);
}
Deno.test("revert UI keeps records and notices in flow, never in an absolute transcript overlay", async () => {
  const css = await Deno.readTextFile(
    "packages/ui/components/ComposerTakeovers.css",
  );
  assertEquals(revertLayoutErrors(css), []);
  assertEquals(revertLayoutErrors(".otk-revert-group {position:absolute}"), [
    ".otk-revert-group",
  ]);
  assertEquals(revertLayoutErrors(".otk-revert-group {display:flex}"), []);
});
Deno.test("saved-branch UI names the copy instead of counting reverted prompts or branches", async () => {
  const source = await Deno.readTextFile(
    "packages/ui/components/SavedBranches.tsx",
  );
  assertEquals(/Unrevert:\s*\{[^}]*branches\.length/.test(source), false);
});
