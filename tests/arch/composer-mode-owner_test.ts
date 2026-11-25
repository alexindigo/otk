// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";

function check(prompt: string, actions: string): string[] {
  return [
    ...(prompt.match(/<PrimaryAction\b/g)?.length === 1
      ? []
      : ["primary count"]),
    ...(prompt.includes("createComposerAction(") &&
        !/label:\s*\(\)\s*=>\s*"(?:Send|Stop)"/.test(prompt)
      ? []
      : ["mode owner"]),
    ...(prompt.includes('activate("enter")') &&
        prompt.includes('activate("button")') &&
        !/composerReady|prompt\.send["']|createSubmissionIntent|composerMode\(/
          .test(prompt)
      ? []
      : ["activation owner"]),
    ...(/\.entry\([^;]*?\)\?*\.status/.test(actions) ? ["run owner"] : []),
  ];
}

Deno.test("the composer borrows mode and session execution from their owners", async () => {
  const [prompt, actions] = await Promise.all([
    Deno.readTextFile("packages/ui/components/Prompt.tsx"),
    Deno.readTextFile("packages/client/session-actions.ts"),
  ]);
  assertEquals(check(prompt, actions), []);
  assertEquals(
    check(
      "<PrimaryAction/><PrimaryAction/>",
      "const busy = resources.entry(id)?.status;",
    ),
    ["primary count", "mode owner", "activation owner", "run owner"],
  );
});
