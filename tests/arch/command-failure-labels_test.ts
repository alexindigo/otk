// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { nodes, property } from "./syntax.ts";

function titleAsAction(text: string): boolean {
  const source = new Source(text);
  return source.all.some((node) =>
    node.type === "ObjectProperty" && property(node.key) === "action" &&
    [...nodes(node.value)].some((value) =>
      (value.type === "MemberExpression" ||
        value.type === "OptionalMemberExpression") &&
      ["title", "label"].includes(property(value.property) ?? "")
    )
  );
}

Deno.test("command failure surfaces never put public titles in action identity facts", async () => {
  for (const [path, text] of await productionSources()) {
    if (/^packages\/ui\/.+\.[jt]sx?$/.test(path)) {
      assertEquals(titleAsAction(text), false, path);
    }
  }
});

Deno.test("command identity gate rejects all reviewed title-as-key shapes", () => {
  for (
    const text of [
      "failureValue(error, { action: commands.metadata(id)?.title ?? id });",
      "failureValue(error, { action: action.title });",
      "failureValue(error, { action: ports.commands.metadata(id)?.title ?? id, target });",
      'fail(error, { action: action?.label ?? "Running notification action" });',
    ]
  ) assert(titleAsAction(text), text);
  assertEquals(
    titleAsAction("failureValue(error, commandFailureFacts(action));"),
    false,
  );
  assertEquals(
    titleAsAction('failureValue(error, { action: "prefs.set" });'),
    false,
  );
});
