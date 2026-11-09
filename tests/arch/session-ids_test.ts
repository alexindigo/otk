// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources } from "./analysis.ts";

function identityErrors(path: string, source: string): string[] {
  const errors: string[] = [];
  if (
    path !== "packages/harness-opencode-v1/ids.ts" && source.includes("opcv1-")
  ) {
    errors.push("native session codec belongs to its single native owner");
  }
  if (
    path !== "packages/harness-opencode-v2-server/ids.ts" &&
    source.includes("opcv2-")
  ) {
    errors.push("native V2 session codec belongs to its single native owner");
  }
  if (
    path.startsWith("core/features/") &&
    /\btext\([^,]+,\s*["'](?:sessionID|parentID)["']/.test(source)
  ) {
    errors.push(
      "session parameters must use the shared qualified-ID validator",
    );
  }
  return errors;
}

Deno.test("qualified native identities have one codec and feature-owned admission uses neutral validation", async () => {
  const errors: string[] = [];
  for (const [path, source] of await productionSources()) {
    errors.push(
      ...identityErrors(path, source).map((error) => `${path}: ${error}`),
    );
  }
  assertEquals(errors, []);
});

Deno.test("identity ownership negatives reject client codecs and unchecked feature IDs", () => {
  assertEquals(
    identityErrors("packages/client/other.ts", 'const id = "opcv1-" + native')
      .length,
    1,
  );
  assertEquals(
    identityErrors(
      "core/features/other.ts",
      'params: p => text(p, "sessionID")',
    ).length,
    1,
  );
  assertEquals(
    identityErrors(
      "core/features/other.ts",
      'params: p => text(p, "parentID", true)',
    ).length,
    1,
  );
  assertEquals(
    identityErrors("core/features/other.ts", "params: p => sessionID(p)")
      .length,
    0,
  );
});
