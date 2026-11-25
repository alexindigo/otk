// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

function closedReturn(node: t.Node | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "TSTypeAnnotation") {
    return closedReturn(node.typeAnnotation);
  }
  if (node.type !== "TSTypeReference") return false;
  if (property(node.typeName) === "SendOutcome") return true;
  return property(node.typeName) === "Promise" &&
    node.typeParameters?.params.length === 1 &&
    closedReturn(node.typeParameters.params[0]);
}

function audit(text: string, owner: string, method?: string): string[] {
  const source = new Source(text), errors: string[] = [];
  const contract = source.all.find((node) =>
    node.type === "TSInterfaceDeclaration" && node.id.name === owner
  );
  if (!contract || contract.type !== "TSInterfaceDeclaration") {
    return ["missing submission contract"];
  }
  const signatures = contract.body.body.filter((node) =>
    method
      ? node.type === "TSMethodSignature" && property(node.key) === method
      : node.type === "TSCallSignatureDeclaration"
  );
  if (signatures.length !== 1 || !closedReturn(signatures[0].typeAnnotation)) {
    errors.push("submission must return SendOutcome");
  }
  return errors;
}

function outcomeKinds(text: string): string[] {
  const alias = new Source(text).all.find((node) =>
    node.type === "TSTypeAliasDeclaration" && node.id.name === "SendOutcome"
  );
  if (
    alias?.type !== "TSTypeAliasDeclaration" ||
    alias.typeAnnotation.type !== "TSUnionType"
  ) return [];
  return alias.typeAnnotation.types.map((node) => {
    if (node.type !== "TSTypeLiteral") return "invalid";
    const kind = node.members.find((member) =>
      member.type === "TSPropertySignature" && property(member.key) === "kind"
    );
    const value = kind?.type === "TSPropertySignature"
      ? kind.typeAnnotation?.typeAnnotation
      : undefined;
    return value?.type === "TSLiteralType" &&
        value.literal.type === "StringLiteral"
      ? value.literal.value
      : "invalid";
  }).sort();
}

/** Inspect only the operation's own returns, never injected observer callbacks. */
function silentPaths(text: string): string[] {
  const source = new Source(text), errors: string[] = [];
  const enclosing = (node: t.Node) => {
    let parent = source.parent.get(node);
    while (
      parent &&
      ![
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
        "ObjectMethod",
      ].includes(parent.type)
    ) parent = source.parent.get(parent);
    return parent;
  };
  const root = source.all.find((node) => node.type === "FunctionDeclaration");
  for (const node of source.all) {
    if (node.type !== "CatchClause") continue;
    const last = node.body.body.at(-1);
    const returned = last?.type === "ReturnStatement" && !!last.argument;
    const settled = node.body.body.some((item) =>
      item.type === "ExpressionStatement" &&
      item.expression.type === "CallExpression" &&
      property(item.expression.callee) === "finish"
    );
    const thrown = last?.type === "ThrowStatement";
    if (!returned && !settled && !thrown) {
      errors.push("catch does not produce an outcome");
    }
  }
  // A direct early return in a submission cannot silently become void success.
  for (const node of source.all) {
    if (
      node.type === "ReturnStatement" && !node.argument &&
      enclosing(node) === root
    ) {
      errors.push("empty submission return");
    }
  }
  return errors;
}

Deno.test("Send outcome audit detects void contracts, silent catch and early returns", () => {
  assertEquals(
    outcomeKinds('type SendOutcome = { kind: "committed" } | void;'),
    ["committed", "invalid"],
  );
  assert(
    audit(
      "export interface SessionSubmission { (): Promise<void>; }",
      "SessionSubmission",
    ).length > 0,
  );
  assert(
    audit(
      "export interface SessionSubmission { (): Promise<SendOutcome | void>; }",
      "SessionSubmission",
    ).length > 0,
  );
  assertEquals(
    audit(
      "export interface SessionSubmission { (): Promise<SendOutcome>; }",
      "SessionSubmission",
    ),
    [],
  );
  assert(
    silentPaths(
      "async function send() { try { return await action(); } catch {} }",
    ).length > 0,
  );
  assert(
    silentPaths(
      "async function send() { if (!ready) return; return await action(); }",
    ).length > 0,
  );
  assertEquals(
    silentPaths(
      "async function send() { try { return await action(); } catch (cause) { return refusedSend(cause); } }",
    ),
    [],
  );
});

Deno.test("all exported submission entry contracts are closed outcomes", async () => {
  assertEquals(
    outcomeKinds(await Deno.readTextFile("packages/client/send-outcome.ts")),
    ["accepted", "committed", "failed", "refused", "unconfirmed"],
  );
  for (
    const [file, owner, method] of [
      ["session-submission.ts", "SessionSubmission", undefined],
      ["session-delivery.ts", "SessionDelivery", "send"],
      ["session-actions.ts", "SessionActions", "prompt"],
    ] as const
  ) {
    const text = await Deno.readTextFile(`packages/client/${file}`);
    assertEquals(audit(text, owner, method), [], file);
    const source = new Source(text);
    for (const node of source.all) {
      if (
        node.type !== "ObjectMethod" ||
        property(node.key) !== (method ?? "prompt")
      ) continue;
      // Asynchronous native observation has its own settlement port; callback
      // returns are not the exported Send result. Inspect direct method paths.
      const body = node.body.body.map((item) =>
        text.slice(item.start!, item.end!)
      ).join("\n");
      if (method) {
        assertEquals(
          silentPaths(
            `async function operation() { ${body} }`,
          ),
          [],
          file,
        );
      }
    }
  }
  const slash = new Source(
    await Deno.readTextFile("packages/ui/features/prompt/slash.ts"),
  );
  const submit = slash.all.find((node) =>
    node.type === "FunctionDeclaration" &&
    node.id?.name === "submitPromptCommand"
  );
  assert(
    submit?.type === "FunctionDeclaration" && closedReturn(submit.returnType),
    "native command entry must return SendOutcome",
  );
});
