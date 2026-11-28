// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function violations(path: string, text: string): string[] {
  const source = new Source(text, path), result: string[] = [];
  const owner = path === "packages/client/transcript.ts";
  for (const node of source.all) {
    if (
      node.type === "JSXElement" &&
      node.openingElement.name.type === "JSXIdentifier" &&
      node.openingElement.name.name === "ToolFrame" &&
      !node.openingElement.attributes.some((attribute) =>
        attribute.type === "JSXAttribute" && attribute.name.name === "body" &&
        attribute.value?.type === "JSXExpressionContainer" &&
        ["ArrowFunctionExpression", "FunctionExpression"].includes(
          attribute.value.expression.type,
        )
      )
    ) {
      result.push("eager folded body");
    }
    if (
      path === "packages/harness-opencode-v1/tasks.ts" &&
      node.type === "AwaitExpression"
    ) result.push("awaited helper shaping");
    if (
      node.type !== "CallExpression" && node.type !== "OptionalCallExpression"
    ) continue;
    const callee = source.name(node.callee) ?? "";
    if (/^packages\/(client|ui)\//.test(path)) {
      const projected =
        /(?:^projection|^createTranscriptProjection|(?:^|\.)(?:transcript|resource)\.projection)\.(reconcile|merge|apply|park|retain|reset|replace|gaps|boundaries)$/
          .exec(callee)?.[1];
      // A local array or promise may also be named `acquired` (viewport code).
      // Follow the factory binding; guard the owner API for member receivers.
      const coverage = /^createAcquiredRange\.(.+)$/.exec(callee)?.[1] ??
        /(?:^|\.)acquired\.(head|extend|ranges|gaps|known|observe|remove|current|visit|evict|clear|replace)$/
          .exec(callee)?.[1];
      const disclosure = /^(?:interaction|createTranscriptInteraction)\.clear$/
        .test(callee);
      const parents = [];
      for (
        let child = node as typeof source.all[number],
          parent = source.parent.get(child);
        parent;
        child = parent, parent = source.parent.get(child)
      ) {
        if (
          parent.type === "VariableDeclarator" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(child.type)
        ) {
          parents.push(parent.id.type === "Identifier" ? parent.id.name : "");
        }
        if (parent.type === "FunctionDeclaration") {
          parents.push(parent.id?.name);
        }
        if (
          parent.type === "ObjectMethod" && parent.key.type === "Identifier"
        ) parents.push(parent.key.name);
        if (
          parent.type === "IfStatement" && child === parent.consequent &&
          (parent.test.type === "MemberExpression" ||
            parent.test.type === "OptionalMemberExpression") &&
          parent.test.object.type === "Identifier" &&
          parent.test.object.name === "known" &&
          parent.test.property.type === "Identifier" &&
          parent.test.property.name === "deleted"
        ) parents.push("deleted-session");
      }
      const detached = callee === "createTranscriptProjection.reset" &&
          path === "packages/ui/components/SessionView.tsx" &&
          parents.includes("SessionView") ||
        path === "packages/client/transcript-projection.ts" &&
          (callee === "createTranscriptProjection.reset" &&
              parents.includes("projectReplies") ||
            (callee === "createTranscriptProjection.reset" ||
                callee === "createTranscriptProjection.boundaries") &&
              parents.includes("projectTranscript"));
      if (
        projected === "replace" || coverage === "replace" ||
        !owner && !detached && (projected || coverage)
      ) {
        result.push("transcript write bypass");
      } else if (
        owner &&
        (projected === "reset" || coverage === "clear" || disclosure) &&
        !parents.some((name) =>
          name === "open" || name === "stop" || name === "deleted-session"
        )
      ) {
        result.push("transcript refresh reset");
      }
    }
    if (
      path.startsWith("packages/ui/") && callee === "createWindow" &&
      path !== "packages/ui/components/VirtualList.tsx"
    ) {
      result.push("duplicate viewport math");
    }
    if (
      path === "packages/harness-opencode-v1/recovery.ts" &&
      /^(?:setTimeout|setInterval|AbortSignal.timeout)$/.test(callee)
    ) {
      result.push("seed recovery owns polling or duplicate timeout");
    }
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
Deno.test("transcript window negatives reject eager folded renderers and duplicate viewport owners", () => {
  assertEquals(
    violations(
      "packages/ui/components/Message.tsx",
      "const view = <ToolFrame><Code /></ToolFrame>; createWindow();",
    ),
    ["eager folded body", "duplicate viewport math"],
  );
  assertEquals(
    violations(
      "packages/ui/components/ToolLine.tsx",
      "const view = <ToolFrame body={() => <Code />} />;",
    ),
    [],
  );
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
Deno.test("seed recovery negatives reject per-delta polling and an independent request deadline", () => {
  assertEquals(
    violations(
      "packages/harness-opencode-v1/recovery.ts",
      "setTimeout(read, 50); setInterval(read, 50); AbortSignal.timeout(15000);",
    ),
    [
      "seed recovery owns polling or duplicate timeout",
      "seed recovery owns polling or duplicate timeout",
      "seed recovery owns polling or duplicate timeout",
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

Deno.test("transcript writes belong to the owner, and recovery cannot reset the lifetime", () => {
  assertEquals(
    violations(
      "packages/ui/components/VirtualList.tsx",
      "acquired.some(visible); acquired.at(-1); acquired.then(settle);",
    ),
    [],
  );
  assertEquals(
    violations(
      "packages/client/session.ts",
      "const range = createAcquiredRange(); const { head: install } = range; install(page); transcript.projection?.reconcile(messages);",
    ),
    ["transcript write bypass", "transcript write bypass"],
  );
  assertEquals(
    violations(
      "packages/ui/components/SessionView.tsx",
      "projection.reset(items); projection.merge(items); acquired.head(page);",
    ),
    [
      "transcript write bypass",
      "transcript write bypass",
      "transcript write bypass",
    ],
  );
  assertEquals(
    violations(
      "packages/client/transcript.ts",
      "function reacquireNewest() { projection.reset([]); acquired.clear(); interaction.clear(); acquired.replace(page); projection.replace(items); }",
    ),
    [
      "transcript refresh reset",
      "transcript refresh reset",
      "transcript refresh reset",
      "transcript write bypass",
      "transcript write bypass",
    ],
  );
  assertEquals(
    violations(
      "packages/client/transcript.ts",
      "const open = () => { projection.reset([]); acquired.clear(); }; const owner = { stop() { interaction.clear(); } }; if (known?.deleted) interaction.clear();",
    ),
    [],
  );
});
