// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function violations(path: string, text: string): string[] {
  const source = new Source(text, path), result: string[] = [];
  for (const node of source.all) {
    if (node.type !== "CallExpression") continue;
    const callee = source.name(node.callee) ?? "";
    if (
      /\.call$/.test(callee) && node.arguments[0]?.type === "StringLiteral" &&
      node.arguments[0].value === "session.messages" &&
      path !== "packages/client/transcript.ts"
    ) result.push("body acquisition outside transcript");
    if (
      callee === "createTranscript" && path !== "packages/client/transcripts.ts"
    ) result.push("body construction outside collection");
  }
  return result;
}
Deno.test("browser message acquisition has one canonical resource owner", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (
      !/^packages\/(client|ui)\/.*\.tsx?$/.test(path) ||
      path.endsWith("example.ts")
    ) continue;
    failures.push(
      ...violations(path, text).map((error) => `${path}: ${error}`),
    );
  }
  assertEquals(failures, []);
});
Deno.test("body acquisition negatives reject selected-facade and UI page caches", () => {
  assertEquals(
    violations(
      "packages/client/session.ts",
      'rpc.call("session.messages", {sessionID});',
    ),
    ["body acquisition outside transcript"],
  );
  assertEquals(
    violations(
      "packages/ui/state/cache.ts",
      'rpc.call("session.messages", {sessionID}); createTranscript(target);',
    ),
    [
      "body acquisition outside transcript",
      "body construction outside collection",
    ],
  );
  assertEquals(
    violations(
      "packages/client/transcript.ts",
      'rpc.call("session.messages", {sessionID});',
    ),
    [],
  );
  assertEquals(
    violations("packages/client/transcripts.ts", "createTranscript(target);"),
    [],
  );
});
