// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { rules } from "./styles.ts";
import { productionSources } from "./analysis.ts";

export function revertLayoutErrors(css: string): string[] {
  return rules(css).filter(({ selector, declarations }) =>
    /(?:revert|rolled-back|saved-branch|composer-notice)/.test(selector) &&
    declarations.get("position") === "absolute"
  ).map(({ selector }) => selector);
}
Deno.test("revert UI keeps records and notices in flow, never in an absolute transcript overlay", async () => {
  for (const [path, css] of await productionSources()) {
    if (path.startsWith("packages/ui/components/") && path.endsWith(".css")) {
      assertEquals(revertLayoutErrors(css), [], path);
    }
  }
  assertEquals(revertLayoutErrors(".otk-revert-group {position:absolute}"), [
    ".otk-revert-group",
  ]);
  assertEquals(revertLayoutErrors(".otk-revert-group {display:flex}"), []);
});
Deno.test("saved-branch UI names the copy instead of counting reverted prompts or branches", async () => {
  const counted = (source: string) =>
    /prompts? rolled back|messageCount|promptCount|Unrevert:\s*\{[^}]*branches\.length/
      .test(source);
  for (
    const path of [
      "packages/ui/components/SavedBranches.tsx",
      "packages/ui/components/RevertGroup.tsx",
      "packages/ui/tests/style-consumer/requests.tsx",
    ]
  ) assertEquals(counted(await Deno.readTextFile(path)), false, path);
  assertEquals(counted("{count()} prompts rolled back"), true);
  assertEquals(counted("1 prompt rolled back"), true);
  assertEquals(counted("Reverted from <time> <first line>"), false);
});
