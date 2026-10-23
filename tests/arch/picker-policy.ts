// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { property } from "./syntax.ts";

export function pickerErrors(path: string, text: string): string[] {
  const result = new Set<string>();
  let source: Source;
  try {
    source = new Source(text, path);
  } catch {
    return ["picker source must parse"];
  }
  const picker = path.endsWith("ListPicker.tsx") ||
    source.all.some((n) =>
      n.type === "FunctionDeclaration" && n.id?.name === "ListPicker"
    );
  const prompt = path.endsWith("Prompt.tsx") ||
    source.all.some((n) =>
      n.type === "FunctionDeclaration" && n.id?.name === "Prompt"
    );
  for (const node of source.all) {
    if (
      path.startsWith("packages/ui/") &&
      ["plan_exit", "plan_enter"].includes(source.string(node) ?? "")
    ) result.add("tool-driven agent selection belongs to the client owner");
    if (
      picker &&
      (node.type === "Identifier" && node.name === "rpc" ||
        node.type === "ImportDeclaration" &&
          node.source.value === "@otk/client" ||
        (node.type === "MemberExpression" ||
            node.type === "OptionalMemberExpression") &&
          /(?:^prefs\.|\.parentElement$|\.querySelector$)/.test(
            source.name(node) ?? "",
          ))
    ) {
      result.add(
        "picker owns interaction only, with injected data and callbacks",
      );
    }
    if (
      prompt &&
      (node.type === "StringLiteral" &&
          ["models.list", "agents.list"].includes(node.value) ||
        node.type === "JSXOpeningElement" &&
          source.name(node.name) === "ListPicker" ||
        node.type === "CallExpression" &&
          ["chooseModel", "chooseVariant"].includes(
            source.name(node.callee) ?? "",
          ))
    ) {
      result.add(
        "prompt host consumes contributions, not concrete picker implementations",
      );
    }
    if (
      node.type === "CallExpression" || node.type === "OptionalCallExpression"
    ) {
      const name = source.name(node.callee) ?? "";
      if (
        /^(?:modelGroups|toggleFavouriteModel|recordRecentModel|chooseAgent|chooseModel|chooseVariant)$/
          .test(name) ||
        path.endsWith("features/prompt/agents.tsx") && name === "JSON.parse"
      ) {
        result.add(
          "composer catalog, selection and preference logic belongs to the client owner",
        );
      }
      if (
        path.endsWith("features/prompt/catalog.ts") &&
        (name === "createSignal" || /\.(?:then|finally)$/.test(name))
      ) result.add("catalog UI module binds the framework-free owner only");
    }
    if (
      path.endsWith("features/prompt/agents.tsx") &&
      (node.type === "NewExpression" &&
          source.name(node.callee) === "Promise" ||
        node.type === "VariableDeclarator" &&
          ["queue", "preferences"].includes(property(node.id) ?? ""))
    ) {
      result.add(
        "composer catalog, selection and preference logic belongs to the client owner",
      );
    }
    if (
      path.endsWith("features/prompt/catalog.ts") &&
      (node.type === "VariableDeclarator" && property(node.id) === "pending" ||
        node.type === "FunctionDeclaration" &&
          node.id?.name === "promptCatalog")
    ) result.add("catalog UI module binds the framework-free owner only");
    if (
      prompt && node.type === "ObjectProperty" &&
      property(node.key) === "nextSelection" &&
      node.value.type === "ArrowFunctionExpression" &&
      node.value.params.some((p) =>
        p.type === "AssignmentPattern" && p.right.type === "CallExpression" &&
        source.name(p.right.callee) === "change"
      )
    ) result.add("rendered selection reads the reactive draft");
  }
  if (
    picker &&
    (!["Popover", "SelectionContent"].every((name) =>
      source.all.some((n) =>
        n.type === "JSXOpeningElement" && source.name(n.name) === name
      )
    ) || !source.all.some((n) =>
      n.type === "JSXSpreadAttribute" && n.argument.type === "CallExpression" &&
      source.name(n.argument.callee) === "selection"
    ))
  ) result.add("picker must use shared surface and selection owners");
  return [...result];
}
