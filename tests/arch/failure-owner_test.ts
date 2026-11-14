// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property } from "./syntax.ts";

export function failureOwnerErrors(path: string, text: string): string[] {
  if (/packages\/client\/failure(?:s|-features)\.ts$/.test(path)) return [];
  const source = new Source(text, path), errors: string[] = [];
  const surface = /packages\/ui\/(?:components|shell|features)\//.test(path);
  for (const node of source.all) {
    if (node.type === "ImportDeclaration") {
      for (const item of node.specifiers) {
        if (item.type !== "ImportSpecifier") continue;
        const name = property(item.imported);
        if (name === "failureText" || surface && name === "errorMessage") {
          errors.push(
            "failure surfaces retain the shared owner's structured value",
          );
        }
      }
    }
    if (node.type === "ObjectExpression") {
      const fields = node.properties.filter((field) =>
        field.type === "ObjectProperty"
      );
      if (
        fields.some((field) =>
          property(field.key) === "kind" &&
          source.string(field.value) === "error"
        ) && fields.some((field) =>
          ["title", "text"].includes(property(field.key) ?? "")
        )
      ) {
        errors.push(
          "failure copy and notification values are produced only by the failure owner",
        );
      }
    }
    if (
      surface && node.type === "CallExpression" &&
      source.name(node.callee)?.match(/^set.*Error$/)
    ) {
      for (const value of node.arguments) {
        if (
          value.type === "MemberExpression" &&
          property(value.property) === "message"
        ) errors.push("raw exception messages cannot become surface state");
      }
    }
  }
  return errors;
}

Deno.test("failure surfaces and notifications have one presentation owner", async () => {
  for (const [path, text] of await productionSources()) {
    if (/^packages\/(?:client|ui)\/.+\.[jt]sx?$/.test(path)) {
      assertEquals(failureOwnerErrors(path, text), [], path);
    }
  }
});

Deno.test("failure gate rejects string bridges, hand-authored failures and raw-message surfaces", () => {
  for (
    const text of [
      'import { failureText as format } from "@otk/client"; const text = format(cause);',
      'const note = { kind: "error", title: "Oops", actions: [] };',
      'const feedback = { kind: "error", text: "Could not do this" };',
      'import { errorMessage as format } from "@otk/protocol"; const text = format(cause);',
      "setError(cause.message);",
    ]
  ) {
    assert(
      failureOwnerErrors("packages/ui/components/Fixture.tsx", text).length > 0,
      text,
    );
  }
  assertEquals(
    failureOwnerErrors(
      "packages/ui/components/Fixture.tsx",
      'import { failureValue } from "@otk/client"; const value = failureValue(cause);',
    ),
    [],
  );
});
