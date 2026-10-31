// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { nodes, property } from "./syntax.ts";

function violations(path: string, text: string): string[] {
  const source = new Source(text, path), result: string[] = [];
  if (path === "packages/content/buffers.ts") {
    for (const node of source.all) {
      if (
        node.type === "CallExpression" &&
        /(?:^|\.)(?:markdown|lex)$/.test(source.name(node.callee) ?? "")
      ) result.push("buffer bypasses producer parser");
    }
  }
  if (path === "packages/harness-opencode-v1/adapter.ts") {
    const event = source.all.find((node) =>
      node.type === "ClassPrivateMethod" && node.key.id.name === "event"
    );
    if (event) {
      for (const node of nodes(event)) {
        if (
          node.type !== "AwaitExpression" ||
          node.argument.type !== "CallExpression"
        ) continue;
        const callee = node.argument.callee;
        const name = callee.type === "MemberExpression" &&
            callee.property.type === "PrivateName"
          ? callee.property.id.name
          : property(callee);
        if (name === "json" || name === "revertInfo") {
          result.push("optional read holds ordered authority");
        }
      }
    }
  }
  return result;
}
Deno.test("stream buffers borrow producer parsing and optional enrichment stays outside ordered authority", () => {
  for (
    const path of [
      "packages/content/buffers.ts",
      "packages/harness-opencode-v1/adapter.ts",
    ]
  ) {
    assertEquals(violations(path, Deno.readTextFileSync(path)), [], path);
  }
});
Deno.test("parse and ordered-enrichment ownership negatives reject original bypasses", () => {
  assertEquals(
    violations(
      "packages/content/buffers.ts",
      'import {markdown as parse} from "./markdown.ts"; parse(active.stream.text);',
    ),
    ["buffer bypasses producer parser"],
  );
  assertEquals(
    violations(
      "packages/harness-opencode-v1/adapter.ts",
      'class Adapter { async #event(){ await this.client.json("/message"); } }',
    ),
    ["optional read holds ordered authority"],
  );
  assertEquals(
    violations(
      "packages/harness-opencode-v1/adapter.ts",
      'class Adapter { #revertInfo(){} async #event(){ await this.#revertInfo(); await this.client["json"]("/message"); } }',
    ),
    [
      "optional read holds ordered authority",
      "optional read holds ordered authority",
    ],
  );
});
