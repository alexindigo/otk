// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function hints(path: string, text: string): string[] {
  const source = new Source(text, path);
  const errors: string[] = [];
  if (
    path !== "packages/client/transcript-scopes.ts" &&
    source.calls("scope").some((call) =>
      source.name(call.callee)?.endsWith(".scope")
    )
  ) {
    errors.push("scope membership belongs to TranscriptScopes");
  }
  if (
    path !== "packages/client/server-resources.ts" &&
    source.all.some((node) => source.string(node) === "digests.scope")
  ) {
    errors.push("scope transport belongs to ServerResources");
  }
  return errors;
}
Deno.test("one client coordinator owns body/digest scope membership", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (path.startsWith("packages/client/")) {
      failures.push(...hints(path, text).map((error) => `${path}: ${error}`));
    }
  }
  assertEquals(failures, []);
});
Deno.test("scope ownership rejects competing calls, aliases and direct RPC producers", () => {
  for (
    const source of [
      `resources.scope(project, [selected]);`,
      `const send = resources.scope; send(project, [selected]);`,
      `const {scope: send} = resources; send(project, []);`,
      `const key='scope'; resources[key](project, []);`,
      `rpc.call('digests.scope', {sessions: []});`,
    ]
  ) assert(hints("packages/client/other.ts", source).length > 0, source);
  assertEquals(
    hints(
      "packages/client/transcript-scopes.ts",
      `resources.scope(project,members);`,
    ),
    [],
  );
  assertEquals(
    hints(
      "packages/client/server-resources.ts",
      `rpc.call('digests.scope', value);`,
    ),
    [],
  );
});
