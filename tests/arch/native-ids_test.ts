// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

const owner = "packages/protocol/identity.ts";
const nativePrefix = /^(?:msg|prt|ses|evt|que|per|tool|pty|wrk)_/;

function violations(path: string, text: string): string[] {
  if (path === owner) return [];
  const source = new Source(text, path), errors: string[] = [];
  for (const node of source.all) {
    if (
      node.type === "TemplateLiteral" && node.expressions.length &&
        nativePrefix.test(node.quasis[0].value.cooked ?? "") ||
      node.type === "BinaryExpression" && node.operator === "+" &&
        nativePrefix.test(source.string(node.left) ?? "")
    ) errors.push("native record IDs must be minted by ascendingID");
    if (
      /(?:^|\/)(?:pending-send|submission-id|prompt)\.ts$/.test(path) &&
      (node.type === "CallExpression" ||
        node.type === "OptionalCallExpression") &&
      /(?:^|\.)(?:randomUUID|getRandomValues|randomID|uuid|nanoid|random)$/
        .test(
          source.name(node.callee) ?? "",
        )
    ) {
      errors.push(
        "native submission identity cannot use a private random generator",
      );
    }
  }
  return errors;
}

Deno.test("native-bound ID creation has one shared owner across browser and adapters", async () => {
  for (const [path, text] of await productionSources()) {
    if (/\.tsx?$/.test(path)) assertEquals(violations(path, text), [], path);
  }
});

Deno.test("native ID ownership rejects UUID fallbacks, aliases and private prefix encoders", () => {
  for (
    const text of [
      'return `msg_${crypto.randomUUID().replaceAll("-", "")}`;',
      'const prefix = "prt_"; return prefix + randomID();',
      "return `ses_${Date.now().toString(16)}${entropy}`;",
      "const { randomUUID: mint } = crypto; return mint();",
      "const mint = crypto.getRandomValues; return mint(new Uint8Array(14));",
      "return randomID();",
    ]
  ) {
    assert(
      violations("packages/harness-opencode-v2-server/prompt.ts", text).length,
      text,
    );
  }
  assertEquals(
    violations(
      "packages/client/pending-send.ts",
      `
    import { ascendingID as mint } from "@otk/protocol";
    export function pendingMessageID() { return mint("msg"); }
  `,
    ),
    [],
  );
  assertEquals(
    violations(
      "packages/harness-opencode-v2-server/messages.ts",
      `
    const id = event.id?.replace(/^evt_/, "msg_");
  `,
    ),
    [],
  );
});
