// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";
import { pathBypasses, presenterBypasses } from "./bypasses.ts";
pathBypasses((source) => errors("NewTool.tsx", source));
presenterBypasses(presenterErrors);

/** Follow value-producing expressions only. A child's props are data, not text
 * rendered by its parent; child text containers are inspected independently. */
function* rendered(
  parsed: Source,
  node: t.Node,
  seen = new Set<t.Node>(),
): Generator<t.Node> {
  if (seen.has(node)) return;
  seen.add(node);
  const value = parsed.value(node);
  if (
    !value || value.type === "JSXElement" || value.type === "JSXFragment" ||
    value.type === "JSXAttribute"
  ) return;
  yield value;
  if (
    value.type === "CallExpression" &&
    parsed.name(value.callee) === "relativeTarget"
  ) return;
  if (value.type === "ConditionalExpression") {
    yield* rendered(parsed, value.consequent, seen);
    yield* rendered(parsed, value.alternate, seen);
  } else if (value.type === "LogicalExpression") {
    yield* rendered(parsed, value.right, seen);
    if (value.operator !== "&&") yield* rendered(parsed, value.left, seen);
  } else if (
    value.type === "ArrowFunctionExpression" ||
    value.type === "FunctionExpression"
  ) {
    yield* rendered(parsed, value.body, seen);
  } else {for (const child of nodes(value)) {
      if (child !== value && parsed.parent.get(child) === value) {
        yield* rendered(parsed, child, seen);
      }
    }}
}

export function errors(name: string, source: string): string[] {
  if (
    /(?:^|\/)tools\/(?:ToolPath\.tsx|paths\.ts)$/.test(name) ||
    name === "ToolPath.tsx" || name === "paths.ts"
  ) return [];
  const result: string[] = [];
  let parsed: Source;
  try {
    parsed = new Source(source);
  } catch {
    return ["path source must parse"];
  }
  const toolBody = !name.includes("/") || name.includes("/components/tools/") ||
    name.endsWith("/components/Diff.tsx");
  for (const node of parsed.all) {
    if (
      toolBody && node.type === "JSXAttribute" &&
      property(node.name) === "class" && [...nodes(node)].some((child) =>
        parsed.string(child)?.split(/\s+/).includes("otk-path")
      )
    ) {
      result.push("file labels belong to ToolPath");
    }
    if (
      toolBody && node.type === "JSXExpressionContainer" &&
      parsed.parent.get(node)?.type !== "JSXAttribute"
    ) {
      const expression = parsed.value(node.expression);
      if (
        expression && [...rendered(parsed, expression)].some((child) =>
          /^(?:(?:props\.)?(?:call|file)\.)?(?:path|oldPath|cwd)(?:\.|$)/.test(
            parsed.name(child) ?? "",
          )
        )
      ) {
        result.push("tool body renders a raw path");
      }
    }
    if (
      (node.type === "CallExpression" ||
        node.type === "OptionalCallExpression") &&
      /(?:\.outputPaths|\.outputContent\.paths)\.(?:join|map)$/.test(
        parsed.name(node.callee) ?? "",
      )
    ) {
      result.push(
        "path-list formatting belongs to ToolOutput and the path presenter",
      );
    }
    if (
      (node.type === "FunctionDeclaration" &&
        node.id?.name === "relativeTarget") ||
      (node.type === "VariableDeclarator" &&
        property(node.id) === "relativeTarget")
    ) {
      result.push("duplicate path presenter");
    }
    if (node.type === "JSXOpeningElement") {
      const component = parsed.name(node.name);
      if (
        ["ToolPath", "Diff", "ReadTool", "SearchTool", "EditTool", "PatchTool"]
          .includes(component ?? "") && !parsed.attr(node, "directory")
      ) {
        result.push(`${component} lost project context`);
      }
    }
  }
  return result;
}
export function presenterErrors(source: string): string[] {
  const parsed = new Source(source);
  return parsed.all.some((node) =>
      node.type === "JSXExpressionContainer" &&
      parsed.parent.get(node)?.type !== "JSXAttribute" && parsed.live(node) &&
      (() => {
        const value = parsed.value(node.expression);
        return value && [...nodes(value)].some((child) =>
          child.type === "CallExpression" &&
          parsed.name(child.callee) === "relativeTarget" &&
          parsed.name(child.arguments[0])?.endsWith(".path") &&
          parsed.name(child.arguments[1])?.endsWith(".directory")
        );
      })()
    )
    ? []
    : ["ToolPath must render its path through the shared presenter"];
}
Deno.test("tool bodies and their diff labels cannot bypass the shared path presenter", async () => {
  const tools = new URL("../../packages/ui/components/tools/", import.meta.url);
  for (const [path, source] of await uiSources()) {
    if (!path.endsWith(".css")) assertEquals(errors(path, source), [], path);
  }
  const owner = await Deno.readTextFile(new URL("ToolPath.tsx", tools));
  assertEquals(presenterErrors(owner), []);
  const output = await Deno.readTextFile(new URL("ToolOutput.tsx", tools));
  assert(
    /result\.paths\.map\(\(path\)\s*=>\s*relativeTarget\(path, props\.directory\)/
      .test(output),
  );
});
Deno.test("path ownership rejects raw fields, aliases, duplicate paint and lost context", () => {
  for (
    const source of [
      'return <span class="otk-path">{call.path}</span>',
      "return <span>{props.call.path}</span>",
      "return <span>{props.call.cwd}</span>",
      'return <span>{props.call.path.replace("/project/", "")}</span>',
      "return <span>{file().oldPath}</span>",
      "return <span>{path()}</span>",
      "const target = props.call.path; return <span>{target}</span>",
      "return <span>{`from ${props.file.oldPath}`}</span>",
      'call.outputPaths.join("\\n")',
      'call.outputContent.paths.join("\\n")',
      "function relativeTarget(path: string) {}",
      "<ReadTool call={props.call} />",
      "<Diff file={file()} />",
      "<ToolPath path={call.path} />",
    ]
  ) assert(errors("BadTool.tsx", source).length > 0, source);
  assertEquals(
    errors(
      "GoodTool.tsx",
      "<ToolPath path={props.call.path} directory={props.directory} />",
    ),
    [],
  );
});
