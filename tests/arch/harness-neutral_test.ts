// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property } from "./syntax.ts";

function violations(path: string, text: string): string[] {
  const source = new Source(text, path), failures: string[] = [];
  for (const node of source.all) {
    if (node.type === "StringLiteral" && /^opencode-[^/]+\//.test(node.value)) {
      failures.push("native qualified kind outside harness");
    }
    // Activity state keys are opaque: shared consumers can display them, not
    // derive outcomes from a native vocabulary (including aliases/destructuring).
    if (
      node.type === "BinaryExpression" &&
      ["===", "!==", "==", "!="].includes(node.operator)
    ) {
      for (
        const [value, other] of [[node.left, node.right], [
          node.right,
          node.left,
        ]]
      ) {
        const name = source.name(value);
        if (
          name && /(?:^|\.)state\.key$/.test(name) &&
          source.string(other) !== undefined
        ) {
          failures.push("native state interpretation outside harness");
        }
      }
    }
    if (
      node.type === "SwitchStatement" &&
      /(?:^|\.)state\.key$/.test(source.name(node.discriminant) ?? "")
    ) {
      failures.push("native state interpretation outside harness");
    }
    if (node.type === "TSInterfaceDeclaration" && node.id.name === "Activity") {
      if (
        node.body.body.some((member) =>
          "key" in member && property(member.key) === "hidden"
        )
      ) {
        failures.push("activity visibility belongs to presentation");
      }
    }
    if (
      node.type === "TSInterfaceDeclaration" && node.id.name === "ActivityState"
    ) {
      for (const key of ["key", "label"]) {
        const member = node.body.body.find((member) =>
          "key" in member && property(member.key) === key
        );
        if (
          member?.type !== "TSPropertySignature" ||
          member.typeAnnotation?.typeAnnotation.type !== "TSStringKeyword"
        ) {
          failures.push("activity state vocabulary must stay open");
        }
      }
    }
  }
  return failures;
}
Deno.test("shared record carrier and consumers remain harness neutral", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (/^packages\/(protocol|client|ui)\/.+\.tsx?$/.test(path)) {
      failures.push(
        ...violations(path, text).map((message) => `${path}: ${message}`),
      );
    }
  }
  assertEquals(failures, []);
});
Deno.test("harness neutrality negatives catch native kinds, state dispatch, aliases and hidden policy", () => {
  assertEquals(
    violations(
      "fixture.ts",
      `
    const kind = "opencode-v2/system";
    if (part.activity.state.key === "completed") {}
    const { key } = part.activity.state;
    if (key === "cancelled") {}
    switch (part.activity.state.key) { case "error": break; }
    interface Activity { hidden?: boolean }
    interface ActivityState { key: "running"; label: string }
  `,
    ).length,
    6,
  );
  assertEquals(
    violations(
      "fixture.ts",
      `
    interface ActivityState { key: string; label: string }
    const title = record.activity.state.label;
    const tone = record.activity.tone === "error";
    const facts = record.activity.state.facts;
  `,
    ),
    [],
  );
});
