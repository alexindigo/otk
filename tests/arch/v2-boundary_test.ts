// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { sourceInventory } from "./analysis.ts";
import { literal, nodes, parse, property, type t } from "./syntax.ts";

const gitOwner = "packages/harness-opencode-v2-server/ignored-files.ts";
function readOnlyGit(node: t.Node): boolean {
  if (
    node.type !== "NewExpression" || node.arguments.length !== 2 ||
    literal(node.arguments[0]) !== "git"
  ) return false;
  const options = node.arguments[1];
  if (options.type !== "ObjectExpression") return false;
  const values = new Map<string, t.Node>();
  for (const item of options.properties) {
    if (item.type !== "ObjectProperty" || item.computed) return false;
    const key = property(item.key);
    if (!key || values.has(key)) return false;
    values.set(key, item.value);
  }
  const args = values.get("args");
  if (
    args?.type !== "ArrayExpression" ||
    JSON.stringify(
        args.elements.map((element) => element ? literal(element) : undefined),
      ) !== JSON.stringify(["check-ignore", "--stdin", "-z", "--no-index"])
  ) return false;
  const clearEnv = values.get("clearEnv");
  if (
    values.size !== 8 || clearEnv?.type !== "BooleanLiteral" || !clearEnv.value
  ) return false;
  for (const key of ["stdin", "stdout", "stderr"]) {
    if (literal(values.get(key)) !== "piped") return false;
  }
  for (const key of ["cwd", "env", "signal"]) {
    const value = values.get(key);
    if (
      value?.type !== "Identifier" ||
      value.name !== (key === "cwd" ? "directory" : key)
    ) return false;
  }
  return true;
}
function lifecycle(path: string, text: string): boolean {
  if (path === gitOwner) {
    const calls = [...nodes(parse(text, path))].filter((node) =>
      node.type === "NewExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Deno" &&
      !node.callee.computed && property(node.callee.property) === "Command" &&
      readOnlyGit(node)
    );
    for (const node of calls.reverse()) {
      if (node.type === "NewExpression") {
        text = text.slice(0, node.callee.start!) + "ReadOnlyGit" +
          text.slice(node.callee.end!);
      }
    }
  }
  return /Service\.(?:ensure|stop)\s*\(|\bDeno\.Command\b|\bprocess\.kill\s*\(/
    .test(text);
}

Deno.test("V2 lifecycle guard permits only the exact owned read-only Git query", () => {
  const query =
    'new Deno.Command("git", {args: ["check-ignore", "--stdin", "-z", "--no-index"], cwd: directory, env, clearEnv: true, signal, stdin: "piped", stdout: "piped", stderr: "piped"})';
  assertEquals(lifecycle(gitOwner, query), false);
  for (
    const text of [
      query.replace('"git"', '"opencode"'),
      query.replace('"check-ignore"', '"reset"'),
      query.replace("clearEnv: true", "clearEnv: false"),
      query.replace("env,", "env, ...override,"),
      query + "; Service.stop()",
    ]
  ) assertEquals(lifecycle(gitOwner, text), true);
  assertEquals(
    lifecycle("packages/harness-opencode-v2-server/adapter.ts", query),
    true,
  );
});

Deno.test("V2 product discovery has no service ownership or native database writes", async () => {
  const errors: string[] = [];
  for (const [path, text] of await sourceInventory({ tests: false })) {
    if (
      !path.startsWith("packages/harness-opencode-v2-server/") &&
      path !== "harness-selection.ts"
    ) continue;
    if (lifecycle(path, text)) {
      errors.push(path + ": native lifecycle ownership");
    }
    if (
      /(?:INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\s+(?:session_v2|session_message|session_part)\b/i
        .test(text)
    ) errors.push(path + ": native write");
  }
  assertEquals(errors, []);
});
