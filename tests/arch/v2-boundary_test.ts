// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { sourceInventory } from "./analysis.ts";

Deno.test("V2 product discovery has no service ownership or native database writes", async () => {
  const errors: string[] = [];
  for (const [path, text] of await sourceInventory({ tests: false })) {
    if (
      !path.startsWith("packages/harness-opencode-v2-server/") &&
      path !== "harness-selection.ts"
    ) continue;
    if (
      /Service\.(?:ensure|stop)\s*\(|\bDeno\.Command\b|\bprocess\.kill\s*\(/
        .test(text)
    ) errors.push(path + ": native lifecycle ownership");
    if (
      /(?:INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\s+(?:session_v2|session_message|session_part)\b/i
        .test(text)
    ) errors.push(path + ": native write");
  }
  assertEquals(errors, []);
});
