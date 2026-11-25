// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";

/** One owner per harness builds native-bound model selections (2.62). */
const OWNERS = new Set([
  "packages/harness-opencode-v1/selection.ts",
  "packages/harness-opencode-v2-server/selection.ts",
]);
const HARNESS = /^packages\/harness-opencode-v[12][^/]*\/(?!tests\/)/;

/** Native transport ports: everything in their arguments is sent natively. */
const TRANSPORT = new Set(["effect", "json", "request", "launch"]);
const ENCODERS = new Set([
  "nativeModel",
  "nativeCommandModel",
  "nativeVariant",
]);

export function modelPayloadViolations(path: string, text: string): string[] {
  if (!HARNESS.test(path) || OWNERS.has(path)) return [];
  const source = new Source(text, path), failures: string[] = [];
  const callee = (node: t.Node) =>
    (node.type === "CallExpression" || node.type === "OptionalCallExpression")
      ? source.name(node.callee)?.split(".").at(-1)
      : undefined;
  const native = (node: t.Node) => {
    for (let at = source.parent.get(node); at; at = source.parent.get(at)) {
      if (TRANSPORT.has(callee(at) ?? "")) return true;
    }
    return false;
  };
  const encoded = (node: t.Node): boolean =>
    ENCODERS.has(callee(node) ?? "") ||
    (node.type === "Identifier" && node.name === "undefined") ||
    (node.type === "ConditionalExpression" && encoded(node.consequent) &&
      encoded(node.alternate));
  for (const node of source.all) {
    if (["switchModel", "switchAgent"].includes(callee(node) ?? "")) {
      failures.push(`${path}: native selection change outside its owner`);
    }
    if (node.type !== "ObjectProperty" || !native(node)) continue;
    const key = property(node.key) ?? "";
    if (["providerID", "modelID"].includes(key)) {
      failures.push(`${path}: native ${key} outside its owner`);
    } else if (
      (key === "model" || key === "variant") && !encoded(node.value as t.Node)
    ) failures.push(`${path}: native ${key} value outside its owner`);
  }
  return failures;
}

Deno.test("native-bound model payloads are built only by each harness's selection owner", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (/\.[cm]?[jt]sx?$/.test(path)) {
      failures.push(...modelPayloadViolations(path, text));
    }
  }
  assertEquals(failures, []);
});

Deno.test("model payload rule detects native-bound literals and switches outside the owner", () => {
  const path = "packages/harness-opencode-v1/shell.ts";
  assertEquals(
    modelPayloadViolations(
      path,
      "launch(id, { body: { variant: v, model: { providerID: m.provider, modelID: m.model } } });",
    ).length,
    4,
  );
  assertEquals(
    modelPayloadViolations(
      "packages/harness-opencode-v2-server/session-actions.ts",
      "await client.effect((api) => api.session.switchModel({ model }));",
    ),
    [
      "packages/harness-opencode-v2-server/session-actions.ts: native selection change outside its owner",
      "packages/harness-opencode-v2-server/session-actions.ts: native model value outside its owner",
    ],
  );
  // Inbound reads and type declarations are not native-bound payloads.
  assertEquals(
    modelPayloadViolations(
      path,
      "type M = { providerID: string }; const p = raw.model.providerID;" +
        " const m = { model: { providerID: p, id: 'x' } };" +
        " client.json(u, { body: { model: input.model ? nativeModel(input.model) : undefined," +
        " variant: nativeVariant(input.variant) } });",
    ),
    [],
  );
  assertEquals(
    modelPayloadViolations(
      "packages/harness-opencode-v1/selection.ts",
      "const v = { providerID: 'a', modelID: 'b' };",
    ),
    [],
  );
});
