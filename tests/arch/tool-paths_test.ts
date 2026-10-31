// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";
import { pathBypasses, presenterBypasses } from "./bypasses.ts";
pathBypasses((source) => errors("NewTool.tsx", source));
presenterBypasses(presenterErrors);

for (
  const [name, source] of [
    [
      "local impostor",
      "function relativeTarget(path, directory) { return path; } function ToolPath(props) { return <span>{relativeTarget(props.path, props.directory)}</span>; }",
    ],
    [
      "wrong module",
      'import { relativeTarget } from "./unrelated.ts"; function ToolPath(props) { return <span>{relativeTarget(props.path, props.directory)}</span>; }',
    ],
    [
      "shadowed import",
      'import { relativeTarget } from "./paths.ts"; function ToolPath(props, relativeTarget) { return <span>{relativeTarget(props.path, props.directory)}</span>; }',
    ],
    [
      "mutated alias",
      'import { relativeTarget } from "./paths.ts"; let format = relativeTarget; format = raw; function ToolPath(props) { return <span>{format(props.path, props.directory)}</span>; }',
    ],
    [
      "dead conditional",
      'import { relativeTarget } from "./paths.ts"; function ToolPath(props) { return <span>{false ? relativeTarget(props.path, props.directory) : props.path}</span>; }',
    ],
    [
      "unused callback value",
      'import { relativeTarget } from "./paths.ts"; function ToolPath(props) { return <span>{() => { relativeTarget(props.path, props.directory); return props.path; }}</span>; }',
    ],
    [
      "unrelated input",
      'import { relativeTarget } from "./paths.ts"; function ToolPath(props, other) { return <span>{relativeTarget(other.path, props.directory)}</span>; }',
    ],
  ]
) {
  Deno.test(`A12 presenter ownership rejects ${name}`, () => {
    assert(presenterErrors(source).length > 0, `Bypass accepted: ${name}`);
  });
}

/** Follow value-producing expressions only. A child's props are data, not text
 * rendered by its parent; child text containers are inspected independently. */
function* rendered(
  parsed: Source,
  node: t.Node,
  seen = new Set<t.Node>(),
): Generator<t.Node> {
  if (seen.has(node)) return;
  seen.add(node);
  if (!parsed.live(node)) return;
  const value = parsed.value(node);
  if (
    !value || value.type === "JSXElement" || value.type === "JSXFragment" ||
    value.type === "JSXAttribute"
  ) return;
  yield value;
  if (
    value.type === "CallExpression" &&
    sharedPresenter(parsed, value.callee)
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
    if (value.body.type === "BlockStatement") {
      for (const statement of nodes(value.body)) {
        if (
          statement.type === "ReturnStatement" && statement.argument &&
          parsed.function(statement) === value
        ) {
          yield* rendered(parsed, statement.argument, seen);
        }
      }
    } else yield* rendered(parsed, value.body, seen);
  } else {for (const child of nodes(value)) {
      if (child !== value && parsed.parent.get(child) === value) {
        yield* rendered(parsed, child, seen);
      }
    }}
}

function sharedPresenter(parsed: Source, node: t.Node): boolean {
  const owner = parsed.imported(node);
  return owner?.name === "relativeTarget" && owner.module === "./paths.ts";
}

Deno.test("A12 presenter ownership accepts imported aliases, renamed inputs and returned callbacks", () => {
  for (
    const source of [
      'import {relativeTarget as format} from "./paths.ts"; export default function Label(input) { const {path: file, directory: root} = input; return <span>{format(file, root)}</span>; }',
      'import * as paths from "./paths.ts"; export default function Label({path: file, directory: root}) { return <span>{() => { const label = paths.relativeTarget(file, root); return label; }}</span>; }',
    ]
  ) assertEquals(presenterErrors(source), [], source);
});

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
        const owner = parsed.function(node);
        const parameter = owner && "params" in owner
          ? owner.params[0]
          : undefined;
        if (!parameter) return false;
        const parameters = [...nodes(parameter)].filter((n) =>
          n.type === "Identifier"
        );
        const input = (value: t.Node | undefined, field: string) => {
          const access = parsed.access(value);
          return access && access.fields.length === 1 &&
            access.fields[0] === field &&
            parameters.some((p) =>
              p.type === "Identifier" &&
              parsed.binding(p.name, p) === access.binding
            );
        };
        return [...rendered(parsed, node.expression)].some((child) =>
          child.type === "CallExpression" &&
          sharedPresenter(parsed, child.callee) &&
          input(child.arguments[0], "path") &&
          input(child.arguments[1], "directory")
        );
      })()
    )
    ? []
    : ["ToolPath must render its path through the shared presenter"];
}

/** The list mapper must return the canonical presenter, preserving both inputs
 * and the accessor borrowed from the data-only server-path context. */
function outputPathErrors(text: string): string[] {
  const source = new Source(text);
  return source.all.some((node) => {
      if (
        node.type !== "CallExpression" || !source.live(node) ||
        !source.name(node.callee)?.endsWith(".paths.map")
      ) return false;
      const callback = source.value(node.arguments[0]);
      if (
        callback?.type !== "ArrowFunctionExpression" ||
        callback.params[0]?.type !== "Identifier"
      ) return false;
      const binding = source.binding(
        callback.params[0].name,
        callback.params[0],
      );
      const values = callback.body.type === "BlockStatement"
        ? callback.body.body.flatMap((statement) =>
          statement.type === "ReturnStatement" && statement.argument
            ? [statement.argument]
            : []
        )
        : [callback.body];
      return values.some((value) => {
        const call = source.value(value);
        if (
          call?.type !== "CallExpression" ||
          !sharedPresenter(source, call.callee)
        ) return false;
        const path = source.access(call.arguments[0]);
        const directory = source.access(call.arguments[1]);
        const map = source.access(node.callee);
        const semantics = source.value(call.arguments[2]);
        if (
          !path || path.binding !== binding || path.fields.length ||
          !directory || directory.fields.join(".") !== "directory" ||
          !map || map.binding !== directory.binding ||
          map.fields.join(".") !== "result.paths.map" ||
          semantics?.type !== "CallExpression" || semantics.arguments.length
        ) return false;
        const accessor = source.value(semantics.callee);
        if (accessor?.type !== "CallExpression" || accessor.arguments.length) {
          return false;
        }
        const owner = source.imported(accessor.callee);
        return owner?.name === "usePathSemantics" &&
          owner.module === "../PathProvider.tsx";
      });
    })
    ? []
    : [
      "ToolOutput must map paths through the shared presenter with borrowed server semantics",
    ];
}

function serverPathErrors(text: string): string[] {
  const source = new Source(text);
  return source.all.some((node) => {
      if (node.type !== "JSXOpeningElement" || !source.live(node)) return false;
      const provider = source.imported(node.name);
      if (
        provider?.name !== "PathProvider" ||
        provider.module !== "./PathProvider.tsx"
      ) return false;
      const paths = source.access(source.attr(node, "paths"));
      if (
        !paths ||
        paths.fields.join(".") !== "directoryCatalog.state.catalog.paths"
      ) return false;
      const owner = source.value(paths.binding?.value);
      if (owner?.type !== "CallExpression") return false;
      const port = source.imported(owner.callee);
      return port?.name === "useSessionPorts" &&
        port.module === "../registries/session.tsx";
    })
    ? []
    : [
      "SessionView must supply path semantics from its borrowed server directory catalog",
    ];
}

function pathContextErrors(text: string): string[] {
  const source = new Source(text);
  let context: ReturnType<Source["binding"]>;
  const supplied = source.all.some((node) => {
    if (node.type !== "JSXOpeningElement") return false;
    const target = source.access(node.name),
      initializer = source.value(target?.binding?.value);
    if (!target || initializer?.type !== "CallExpression") return false;
    const imported = source.imported(initializer.callee);
    if (imported?.name !== "createContext" || imported.module !== "solid-js") {
      return false;
    }
    const value = source.value(source.attr(node, "value"));
    if (value?.type !== "ArrowFunctionExpression") return false;
    const input = source.access(value.body), owner = source.function(node);
    if (
      owner?.type !== "FunctionDeclaration" ||
      owner.id?.name !== "PathProvider" || !source.live(node)
    ) return false;
    const parameter = owner && "params" in owner ? owner.params[0] : undefined;
    if (
      !input || input.fields.join(".") !== "paths" ||
      parameter?.type !== "Identifier" ||
      source.binding(parameter.name, parameter) !== input.binding
    ) return false;
    context = target.binding;
    return true;
  });
  const borrowed = source.all.some((node) => {
    if (
      node.type !== "ReturnStatement" ||
      node.argument?.type !== "ArrowFunctionExpression"
    ) return false;
    const hook = source.function(node),
      declaration = hook && source.parent.get(hook);
    if (
      declaration?.type !== "VariableDeclarator" ||
      declaration.id.type !== "Identifier" ||
      declaration.id.name !== "usePathSemantics" || !source.live(node)
    ) return false;
    const returned = source.value(node.argument.body);
    if (
      returned?.type !== "OptionalCallExpression" &&
      returned?.type !== "CallExpression"
    ) return false;
    const read = source.value(returned.callee);
    if (read?.type !== "CallExpression") return false;
    const imported = source.imported(read.callee);
    return imported?.name === "useContext" && imported.module === "solid-js" &&
      source.access(read.arguments[0])?.binding === context;
  });
  return supplied && borrowed ? [] : [
    "Path context must forward and borrow only its supplied server semantics",
  ];
}

const outputFixture = (accessor: string, argument = "paths()") => `
import { relativeTarget } from "./paths.ts";
import { usePathSemantics } from "../PathProvider.tsx";
export default function Output(props) { const paths=${accessor};
  const result=props.result; return result.paths.map(path=>relativeTarget(path,props.directory,${argument})).join("\\n"); }`;
Deno.test("path semantics guard rejects absent, browser-owned, counterfeit and discarded inputs", () => {
  for (
    const source of [
      outputFixture("usePathSemantics()", "undefined"),
      outputFixture("usePathSemantics()", "{style:'posix',separator:'/'}"),
      outputFixture("()=>navigator.platform", "paths()"),
      outputFixture("usePathSemantics()", "props.paths"),
      outputFixture("usePathSemantics()").replace(
        '"../PathProvider.tsx"',
        '"./counterfeit.ts"',
      ),
      outputFixture("usePathSemantics()").replace(
        "props.directory",
        "other.directory",
      ),
      outputFixture("usePathSemantics()").replace(
        "path=>relativeTarget(path,props.directory,paths())",
        "path=>{relativeTarget(path,props.directory,paths());return path;}",
      ),
      outputFixture("usePathSemantics()").replace(
        "function Output(props)",
        "function Output(props,relativeTarget)",
      ),
    ]
  ) assert(outputPathErrors(source).length > 0, source);
  assertEquals(outputPathErrors(outputFixture("usePathSemantics()")), []);
  const server =
    `import {PathProvider} from "./PathProvider.tsx"; import {useSessionPorts} from "../registries/session.tsx";
    function View(){const port=useSessionPorts();return <PathProvider paths={port.directoryCatalog.state.catalog.paths}>content</PathProvider>;}`;
  assertEquals(serverPathErrors(server), []);
  for (
    const bad of [
      server.replace(
        "port.directoryCatalog.state.catalog.paths",
        "navigator.platform",
      ),
      server.replace("port.directoryCatalog.state.catalog.paths", "port.paths"),
      server.replace('"../registries/session.tsx"', '"./counterfeit.ts"'),
    ]
  ) assert(serverPathErrors(bad).length > 0);
  const context = `import {createContext,useContext} from "solid-js";
    const Context=createContext();function PathProvider(props){return <Context value={()=>props.paths}>content</Context>;}
    const usePathSemantics=()=>{const paths=useContext(Context);return ()=>paths?.();};`;
  assertEquals(pathContextErrors(context), []);
  for (
    const bad of [
      context.replace("props.paths", "navigator.platform"),
      context.replace("paths?.()", "navigator.platform"),
      context.replace("useContext(Context)", "useContext(OtherContext)"),
      context.replace("const usePathSemantics=", "const unusedHook=") +
      "const usePathSemantics=()=>()=>navigator.platform;",
    ]
  ) assert(pathContextErrors(bad).length > 0);
});
Deno.test("tool bodies and their diff labels cannot bypass the shared path presenter", async () => {
  const tools = new URL("../../packages/ui/components/tools/", import.meta.url);
  for (const [path, source] of await uiSources()) {
    if (!path.endsWith(".css")) assertEquals(errors(path, source), [], path);
  }
  const owner = await Deno.readTextFile(new URL("ToolPath.tsx", tools));
  assertEquals(presenterErrors(owner), []);
  const output = await Deno.readTextFile(new URL("ToolOutput.tsx", tools));
  assertEquals(outputPathErrors(output), []);
  assertEquals(
    serverPathErrors(
      await Deno.readTextFile(new URL("../SessionView.tsx", tools)),
    ),
    [],
  );
  assertEquals(
    pathContextErrors(
      await Deno.readTextFile(new URL("../PathProvider.tsx", tools)),
    ),
    [],
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
