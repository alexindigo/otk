// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property } from "./syntax.ts";

function boundaryErrors(path: string, text: string): string[] {
  const generic = /packages\/(?:client|ui)\//.test(path);
  if (!generic || path.endsWith(".css")) return [];
  const parsed = new Source(text, path), errors = new Set<string>();
  for (const node of parsed.all) {
    if (node.type !== "StringLiteral") continue;
    const value = node.value;
    if (value === "history.attachment") {
      errors.add("recall bytes use origin batches");
    }
    if (["plan_enter", "plan_exit"].includes(value)) {
      errors.add("native transition semantics belong to the provider");
    }
  }
  for (const node of parsed.all) {
    if (
      !path.includes("packages/ui/features/prompt/") ||
      node.type !== "CallExpression"
    ) continue;
    const method = parsed.string(node.arguments[0]);
    if (
      !method ||
      ![
        "find.files",
        "agents.list",
        "commands.list",
        "models.list",
        "resources.list",
      ].includes(method)
    ) continue;
    let parent = parsed.parent.get(node);
    while (parent) {
      if (
        (parent.type === "ObjectMethod" || parent.type === "ObjectProperty") &&
        property(parent.key) === "options"
      ) {
        errors.add("shipped completion borrows the shared directory catalog");
        break;
      }
      parent = parsed.parent.get(parent);
    }
  }
  return [...errors];
}

Deno.test("remaining data consumers retain directory, attachment-batch and native-semantic boundaries", async () => {
  for (const [path, text] of await productionSources()) {
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    assertEquals(boundaryErrors(path, text), [], path);
  }
});
Deno.test("remaining boundary negatives reject old point and native-name discovery paths", () => {
  for (
    const method of [
      "history.attachment",
      "find.files",
      "agents.list",
      "commands.list",
      "models.list",
      "resources.list",
      "plan_enter",
      "plan_exit",
    ]
  ) {
    assert(
      boundaryErrors(
        "packages/ui/features/prompt/nested/source.ts",
        `const request = "${method}"; const source={options(){return port.call(request, params)}};`,
      ).length > 0,
      method,
    );
  }
  assertEquals(
    boundaryErrors(
      "packages/harness-opencode-v1/selection-intent.ts",
      'const native="plan_exit";',
    ),
    [],
  );
  assertEquals(
    boundaryErrors(
      "packages/ui/features/prompt/mentions.ts",
      'const value=ports.directoryCatalog.view("files");',
    ),
    [],
  );
  assertEquals(
    boundaryErrors(
      "packages/client/session-actions.ts",
      'port.call("history.attachments", {refs});',
    ),
    [],
  );
  assertEquals(
    boundaryErrors(
      "packages/ui/features/prompt/paste.ts",
      'const paste=()=>ctx.rpc("find.files",{query:path});',
    ),
    [],
  );
});
