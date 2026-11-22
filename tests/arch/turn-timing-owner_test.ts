// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertMatch } from "@std/assert";
Deno.test("turn-duration consumers render the accumulator result without endpoint arithmetic", async () => {
  for (
    const [name, presenter] of [
      ["Message", /messageTimeValue\(/],
      ["WorkLog", /workingTimeValue\(/],
      ["UsageDetail", /workingTimeValue\(/],
    ] as const
  ) {
    const source = await Deno.readTextFile(
      `packages/ui/components/${name}.tsx`,
    );
    assertMatch(source, presenter);
    assertMatch(source, /<TimeValue\b/);
    assert(!/\belapsed\(/.test(source), `${name} reconstructs a wall span`);
  }
  const projection = await Deno.readTextFile(
    "packages/client/transcript-projection.ts",
  );
  assert(
    !/time:\s*\{[^}]*created:\s*first\.time\.created/s.test(projection),
    "loaded pages manufacture a second timing span",
  );
});
Deno.test("stream consumers share terminal facts instead of requiring an end timestamp", async () => {
  for (
    const path of [
      "packages/client/reduce.ts",
      "packages/client/stream-last-good.ts",
      "packages/client/transcript-projection.ts",
      "packages/ui/components/Message.tsx",
    ]
  ) {
    const source = await Deno.readTextFile(path);
    assertMatch(source, /isAssistantTerminal\(/);
    assert(
      !/time\.completed\s*(?:===|!==)\s*undefined/.test(source),
      `${path} confuses settlement with endpoint availability`,
    );
  }
});
