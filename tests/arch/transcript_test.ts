// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function violations(path: string, text: string): string[] {
  const source = new Source(text, path), result: string[] = [];
  for (const node of source.all) {
    if (
      path === "packages/harness-opencode-v1/tasks.ts" &&
      node.type === "AwaitExpression"
    ) result.push("awaited helper shaping");
    if (node.type !== "CallExpression") continue;
    const callee = source.name(node.callee) ?? "";
    if (
      path === "packages/harness-opencode-v1/tasks.ts" &&
      /(?:\.(?:read|scan|page|taskMessages|schedule)|^setTimeout)$/.test(callee)
    ) result.push("helper link owns I/O or polling");
    if (
      /\.call$/.test(callee) && node.arguments[0]?.type === "StringLiteral" &&
      node.arguments[0].value === "session.messages" &&
      path !== "packages/client/transcript.ts"
    ) result.push("body acquisition outside transcript");
    if (
      callee === "createTranscript" && path !== "packages/client/transcripts.ts"
    ) result.push("body construction outside collection");
    if (
      path === "packages/ui/components/SessionView.tsx" &&
      ["replyMessages", "queuedMessages", "replyMetadata", "turnUsage"]
        .includes(callee)
    ) result.push("whole-history projection in transcript view");
    if (
      path === "packages/client/session-usage.ts" && /\.snapshot$/.test(callee)
    ) result.push("detached ledger snapshot on live detail path");
    if (
      path.startsWith("packages/ui/") && /\.call$/.test(callee) &&
      node.arguments[0]?.type === "StringLiteral" &&
      node.arguments[0].value === "usage.get"
    ) result.push("detail acquisition in view");
  }
  return result;
}
Deno.test("browser message acquisition has one canonical resource owner", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (
      !/^packages\/(client|ui|harness-opencode-v1)\/.*\.tsx?$/.test(path) ||
      path.endsWith("example.ts")
    ) continue;
    failures.push(
      ...violations(path, text).map((error) => `${path}: ${error}`),
    );
  }
  assertEquals(failures, []);
});
Deno.test("helper link negatives reject awaited child scans and parent polling", () => {
  assertEquals(
    violations(
      "packages/harness-opencode-v1/tasks.ts",
      "async function shape() { await reader.scan(child); clock.schedule(refresh, 50); reader.read(parent, message); }",
    ),
    [
      "awaited helper shaping",
      "helper link owns I/O or polling",
      "helper link owns I/O or polling",
      "helper link owns I/O or polling",
    ],
  );
});
Deno.test("transcript hot-path negatives reject UI regrouping, per-row detail reads and detached live ledgers", () => {
  assertEquals(
    violations(
      "packages/ui/components/SessionView.tsx",
      "replyMessages(messages); queuedMessages(messages);",
    ),
    [
      "whole-history projection in transcript view",
      "whole-history projection in transcript view",
    ],
  );
  assertEquals(
    violations("packages/client/session-usage.ts", "ledger.snapshot();"),
    ["detached ledger snapshot on live detail path"],
  );
  assertEquals(
    violations(
      "packages/ui/components/Message.tsx",
      'rpc.call("usage.get", {sessionID,turnID});',
    ),
    ["detail acquisition in view"],
  );
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
