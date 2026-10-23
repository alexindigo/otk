// SPDX-License-Identifier: LGPL-3.0-only
import type { Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

const isCall = (node: t.Node | undefined): node is
  | t.CallExpression
  | t.OptionalCallExpression =>
  node?.type === "CallExpression" || node?.type === "OptionalCallExpression";
const isFunction = (node: t.Node | undefined): node is
  | t.ArrowFunctionExpression
  | t.FunctionExpression =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";

/** Admission is a callback of the real session-bound port, not merely nested
 * under a function whose spelling happens to be submit. Keep this local proof
 * conservative: callbacks are inline and cannot escape to another invoker. */
export function submissionErrors(path: string, source: Source): string[] {
  if (!/^(?:packages\/(?:client|ui)\/|web\/src\/)/.test(path)) return [];
  const modulePath = (module: string) =>
    module.startsWith(".")
      ? new URL(module, `file:///repo/${path}`).pathname.slice("/repo/".length)
      : module;
  const imported = (node: t.Node, name: string, owner: string) => {
    const value = source.imported(node);
    return value?.name === name &&
      [owner, owner.startsWith("packages/client/") ? "@otk/client" : "@otk/ui"]
        .includes(modulePath(value.module));
  };
  type Binding = NonNullable<ReturnType<Source["access"]>>["binding"];
  const contexts = new Set<Binding>(), registries = new Set<Binding>();
  const bind = (node: t.Node | undefined, into: Set<Binding>) => {
    const value = source.access(node);
    if (value && !value.fields.length) into.add(value.binding);
  };
  const parameterType = (node: t.Node) => {
    const annotation = "typeAnnotation" in node
      ? node.typeAnnotation
      : undefined;
    return annotation?.type === "TSTypeAnnotation" &&
        annotation.typeAnnotation.type === "TSTypeReference"
      ? annotation.typeAnnotation.typeName
      : undefined;
  };
  for (const node of source.all) {
    if (source.function(node) !== node || !("params" in node)) continue;
    for (const param of node.params) {
      const type = parameterType(param);
      if (!type) continue;
      if (
        imported(type, "PromptContext", "packages/ui/registries/prompt.ts") ||
        imported(type, "SessionPorts", "packages/ui/registries/session.tsx")
      ) bind(param, contexts);
      if (
        imported(type, "PromptRegistry", "packages/ui/registries/prompt.ts")
      ) {
        bind(param, registries);
      }
    }
  }
  for (const node of source.all) {
    if (!isCall(node)) continue;
    const port = source.access(node.callee);
    if (
      !port || !registries.has(port.binding) ||
      port.fields.join(".") !== "register"
    ) continue;
    const definition = source.value(node.arguments[0]);
    if (definition?.type !== "ObjectExpression") continue;
    for (const item of definition.properties) {
      if (item.type !== "ObjectProperty" || property(item.key) !== "create") {
        continue;
      }
      const create = source.value(item.value);
      if (isFunction(create)) bind(create.params[0], contexts);
    }
  }
  const portContext = (node: t.Node) => {
    const port = source.access(node);
    return port && contexts.has(port.binding) &&
        port.fields.join(".") === "submit"
      ? port.binding
      : undefined;
  };
  const factoryResult = (node: t.Node | undefined, depth = 0): boolean => {
    if (!node || depth > 12) return false;
    const value = source.value(node);
    if (!isCall(value)) return false;
    if (
      imported(
        value.callee,
        "createSessionSubmission",
        "packages/client/session-submission.ts",
      )
    ) return true;
    const callee = source.value(value.callee);
    // An immutable local binder may return the real factory's port. Do not
    // infer ownership from its identifier or from an arbitrary function body.
    return isFunction(callee) && callee.body.type !== "BlockStatement" &&
      factoryResult(callee.body, depth + 1);
  };
  const string = (node: t.Node | undefined, depth = 0): string | undefined => {
    if (!node || depth > 12) return;
    const value = source.value(node);
    const literal = source.string(value);
    if (literal !== undefined) return literal;
    if (value?.type === "BinaryExpression" && value.operator === "+") {
      const left = string(value.left, depth + 1);
      const right = string(value.right, depth + 1);
      if (left !== undefined && right !== undefined) return left + right;
    }
    if (value?.type === "TemplateLiteral") {
      let result = value.quasis[0].value.cooked ?? "";
      for (let i = 0; i < value.expressions.length; i++) {
        const part = string(value.expressions[i], depth + 1);
        if (part === undefined) return;
        result += part + (value.quasis[i + 1].value.cooked ?? "");
      }
      return result;
    }
  };
  const admissions = new Set([
    "session.prompt",
    "session.shell",
    "session.command",
  ]);
  const operation = (node: t.Node): string | undefined => {
    const method = string(node);
    if (method && admissions.has(method)) return method;
    const value = source.value(node);
    // Function.call/apply and constant argument arrays cannot hide a named RPC.
    if (value?.type === "ArrayExpression") {
      for (const item of value.elements) {
        if (item) {
          const method = string(item);
          if (method && admissions.has(method)) return method;
        }
      }
    }
  };
  const errors: string[] = [];
  for (const node of source.all) {
    if (!isCall(node)) continue;
    const method = node.arguments.map(operation).find(Boolean);
    if (!method) continue;
    const callback = source.function(node);
    let argument = callback;
    while (argument) {
      const parent = source.parent.get(argument);
      if (
        !parent ||
        !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]
          .includes(parent.type)
      ) break;
      argument = parent;
    }
    const admission = argument && source.parent.get(argument);
    let accepted = false;
    if (
      callback && isFunction(callback) && isCall(admission) &&
      admission.arguments[0] === argument && source.live(admission)
    ) {
      const context = portContext(admission.callee);
      const rpc = source.access(node.callee);
      accepted = context
        ? !rpc || !contexts.has(rpc.binding) || context === rpc.binding
        : factoryResult(admission.callee);
    }
    if (!accepted) {
      errors.push(
        `${method} at line ${
          node.loc?.start.line ?? "?"
        } must execute inside an inline callback of the session submit port`,
      );
    }
  }
  return errors;
}
