// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { nodes, parse, property, type t } from "./syntax.ts";

function directAwaits(node: t.Node): t.AwaitExpression[] {
  const result: t.AwaitExpression[] = [];
  const visit = (value: t.Node) => {
    if (
      value !== node &&
      ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]
        .includes(value.type)
    ) return;
    if (value.type === "AwaitExpression") result.push(value);
    for (const [key, raw] of Object.entries(value)) {
      if (
        ["loc", "comments", "leadingComments", "trailingComments", "extra"]
          .includes(key)
      ) continue;
      for (const child of Array.isArray(raw) ? raw : [raw]) {
        if (
          child && typeof child === "object" && typeof child.type === "string"
        ) visit(child);
      }
    }
  };
  visit(node);
  return result;
}
function rawReadiness(source: string): boolean {
  return [...nodes(parse(source))].some((node) => {
    if (node.type !== "AwaitExpression") return false;
    const value = node.argument;
    if (value.type === "NewExpression") return true;
    if (value.type !== "CallExpression") return false;
    const callee = value.callee;
    return callee.type === "MemberExpression" && (
      property(callee) === "fetcher" ||
      (callee.object.type === "Identifier" &&
        ["json", "text", "arrayBuffer", "all"].includes(property(callee)!))
    );
  });
}
function holdsExecutingWait(source: string): boolean {
  return [...nodes(parse(source))].some((node) => {
    if (node.type !== "ClassPrivateMethod" || node.key.id.name !== "tick") {
      return false;
    }
    return directAwaits(node.body).some(({ argument }) =>
      argument.type === "CallExpression" &&
      ["run", "step", "sleep", "waitDuty"].includes(
        property(argument.callee as t.Node)!,
      )
    );
  });
}
function unownedCredit(source: string): boolean {
  const tree = parse(source);
  const yields = new Set([...nodes(tree)].flatMap((node) => {
    if (
      node.type !== "FunctionDeclaration" || !node.id ||
      node.body.body.length !== 1
    ) return [];
    const statement = node.body.body[0];
    if (
      statement.type !== "ReturnStatement" ||
      statement.argument?.type !== "CallExpression"
    ) return [];
    const call = statement.argument;
    if (call.callee.type !== "Identifier" || call.callee.name !== "wait") {
      return [];
    }
    const readiness = call.arguments[0];
    return readiness?.type === "CallExpression" &&
        readiness.callee.type === "Identifier" &&
        readiness.callee.name === "sleep" &&
        readiness.arguments[0]?.type === "NumericLiteral" &&
        readiness.arguments[0].value === 0
      ? [node.id.name]
      : [];
  }));
  const batch = [...nodes(tree)].some((node) =>
    node.type === "NewExpression" && node.callee.type === "Identifier" &&
    node.callee.name === "DigestBatch"
  );
  const sends = [...nodes(tree)].filter((node) =>
    node.type === "FunctionDeclaration" &&
    ["send", "sendRaw"].includes(node.id?.name ?? "")
  ) as t.FunctionDeclaration[];
  return sends.some((send) =>
    directAwaits(send.body).some(({ argument }) => {
      if (argument.type !== "CallExpression") return true;
      const callee = argument.callee;
      if (
        callee.type === "Identifier" &&
        (["wait", "sendRaw"].includes(callee.name) || yields.has(callee.name))
      ) return false;
      return !(batch && callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "batches" && property(callee) === "append");
    })
  );
}
function dispatcherBackoff(source: string): boolean {
  const pump = [...nodes(parse(source))].find((node) =>
    node.type === "FunctionDeclaration" && node.id?.name === "pump"
  ) as t.FunctionDeclaration | undefined;
  return !!pump &&
    directAwaits(pump.body).some(({ argument }) =>
      argument.type === "CallExpression" &&
      argument.callee.type === "Identifier" &&
      argument.callee.name === "sleep" &&
      !(argument.arguments[0]?.type === "NumericLiteral" &&
        argument.arguments[0].value === 0)
    );
}

Deno.test("digest execution cannot hold a whole request, native readiness or publication-credit wait", () => {
  const read = (path: string) =>
    Deno.readTextFileSync(new URL("../../" + path, import.meta.url));
  assertEquals(
    holdsExecutingWait(read("packages/harness/digest-scheduler.ts")),
    false,
  );
  assertEquals(unownedCredit(read("core/digest/worker.ts")), false);
  assertEquals(
    dispatcherBackoff(read("core/digest/worker.ts")),
    false,
    "A failed job cannot suspend the whole dispatcher",
  );
  for (
    const path of [
      "packages/harness-opencode-v1/client.ts",
      "packages/harness-opencode-v1/messages.ts",
      "packages/harness-opencode-v1/digest.ts",
    ]
  ) assertEquals(rawReadiness(read(path)), false, path);
  const worker = read("core/digest/worker.ts");
  assertEquals(
    /let\s+(?:requestSignal|catalogPublications)\b/.test(worker),
    false,
    "Async lifetimes cannot share a mutable current-request context",
  );
  assertEquals(
    /busyms:\s*policy\.busyms/.test(worker),
    false,
    "SQLite lock waiting must not block the worker's executing turn",
  );
});
Deno.test("digest wait ownership negatives retain the reported blocking paths", () => {
  assertEquals(
    holdsExecutingWait(
      "class Scheduler { async #tick(){ await request.run(); } }",
    ),
    true,
  );
  assertEquals(
    holdsExecutingWait(
      "class Scheduler { async #tick(){ await sink.step(job); } }",
    ),
    true,
  );
  assertEquals(
    holdsExecutingWait(
      "class Scheduler { async #tick(){ await turn.resume(); } }",
    ),
    false,
  );
  assertEquals(
    unownedCredit(
      "async function send(){ await new Promise(resolve=>credits.add(resolve)); }",
    ),
    true,
  );
  assertEquals(
    unownedCredit(
      "async function send(){ await wait(new Promise(resolve=>credits.add(resolve))); }",
    ),
    false,
  );
  assertEquals(
    unownedCredit(
      "async function sendRaw(){ await new Promise(resolve=>credits.add(resolve)); }",
    ),
    true,
  );
  assertEquals(
    unownedCredit("async function send(){ await fake.append(credit); }"),
    true,
  );
  assertEquals(
    unownedCredit(
      "function yieldChunk(){return wait(sleep(0, signal));} async function sendRaw(){await yieldChunk();}",
    ),
    false,
  );
  assertEquals(
    unownedCredit(
      "function yieldChunk(){return rawCredit();} async function sendRaw(){await yieldChunk();}",
    ),
    true,
  );
  assertEquals(
    dispatcherBackoff("async function pump(){ await sleep(1000,signal); }"),
    true,
  );
  assertEquals(
    dispatcherBackoff("async function pump(){ await sleep(0,signal); }"),
    false,
  );
  for (
    const value of [
      "await this.fetcher(url)",
      "await response.json()",
      "await Promise.all(hashes)",
      "await new Promise(resolve=>permission(resolve))",
    ]
  ) {
    assertEquals(
      rawReadiness("async function read(){" + value + "}"),
      true,
      value,
    );
  }
  assertEquals(
    rawReadiness("async function read(){ await this.wait(response.json()); }"),
    false,
  );
});
