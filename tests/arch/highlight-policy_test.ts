// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";

const consumers = [
  "highlight/lines.ts",
  "highlight/client.ts",
  "highlight/worker.ts",
  "components/CodeGroup.tsx",
];

for (const path of consumers) {
  Deno.test(`highlight row grouping is policy-owned in ${path}`, async () => {
    const source = new Source(
      await Deno.readTextFile(
        new URL(`../../packages/ui/${path}`, import.meta.url),
      ),
      path,
    );
    const duplicates = source.all.filter((node) =>
      node.type === "NumericLiteral" && node.value === 32
    );
    assertEquals(
      duplicates.map((node) => node.loc?.start.line),
      [],
      `${path} duplicates the shared row-group contract`,
    );
    assert(
      source.all.some((node) => {
        if (node.type !== "BinaryExpression" || !source.live(node)) {
          return false;
        }
        const owner = source.imported(node.right);
        return owner?.name === "HIGHLIGHT_GROUP_ROWS" &&
          new URL(
              owner.module,
              new URL(`../../packages/ui/${path}`, import.meta.url),
            )
              .href ===
            new URL("../../packages/ui/highlight/policy.ts", import.meta.url)
              .href;
      }),
      `${path} does not consume the shared row-group policy`,
    );
  });
}
