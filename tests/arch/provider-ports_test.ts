// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { type t } from "./syntax.ts";

/** Context values are ports; composition props (and their lazy getters) cannot escape. */
function leaks(text: string, path = "fixture.tsx"): number[] {
  const source = new Source(text, path);
  const inputs = new Set<ReturnType<Source["binding"]>>();
  for (const node of source.all) {
    if (!("params" in node) || !Array.isArray(node.params)) continue;
    for (const param of node.params as t.Node[]) {
      if (param.type === "Identifier") {
        inputs.add(source.binding(param.name, node));
      } else if (param.type === "ObjectPattern") {
        for (const field of param.properties) {
          if (
            field.type === "RestElement" && field.argument.type === "Identifier"
          ) {
            inputs.add(source.binding(field.argument.name, node));
          }
        }
      }
    }
  }
  const exposed = (
    raw: t.Node | undefined,
    seen = new Set<t.Node>(),
  ): boolean => {
    if (!raw || seen.has(raw)) return false;
    seen.add(raw);
    const access = source.access(raw);
    if (access && inputs.has(access.binding)) {
      return !access.fields.length || access.fields.includes("children");
    }
    const node = source.value(raw);
    if (!node) return false;
    if (node !== raw) return exposed(node, seen);
    if (node.type === "ObjectExpression") {
      return node.properties.some((p) => {
        if (p.type === "SpreadElement") return exposed(p.argument, seen);
        if (p.type === "ObjectProperty") return exposed(p.value, seen);
        return p.body.body.some((statement) =>
          statement.type === "ReturnStatement" &&
          exposed(statement.argument ?? undefined, seen)
        );
      });
    }
    if (node.type === "CallExpression") {
      return node.arguments.some((arg) => exposed(arg, seen));
    }
    if (node.type === "ConditionalExpression") {
      return exposed(node.consequent, seen) || exposed(node.alternate, seen);
    }
    if (node.type === "LogicalExpression") {
      return exposed(node.left, seen) || exposed(node.right, seen);
    }
    if (node.type === "Identifier") {
      // A rest copy is still an implicit surface, even if it omits children today.
      const binding = source.binding(node.name, node);
      return source.all.some((d) =>
        d.type === "VariableDeclarator" && d.id.type === "ObjectPattern" &&
        d.id.properties.some((p) =>
          p.type === "RestElement" && p.argument.type === "Identifier" &&
          source.binding(p.argument.name, d) === binding
        ) && exposed(d.init ?? undefined, seen)
      );
    }
    return false;
  };
  const contexts = new Set(source.all.flatMap((node) => {
    if (
      node.type !== "VariableDeclarator" || node.id.type !== "Identifier" ||
      node.init?.type !== "CallExpression"
    ) return [];
    const imported = source.imported(node.init.callee);
    return imported?.name === "createContext" &&
        ["solid-js", "@solidjs/signals"].includes(imported.module)
      ? [source.binding(node.id.name, node)]
      : [];
  }));
  return source.all.flatMap((node) => {
    if (node.type !== "JSXOpeningElement") return [];
    const target = source.access(node.name);
    if (!target || !contexts.has(target.binding)) return [];
    return exposed(source.attr(node, "value")) ||
        node.attributes.some((a) =>
          a.type === "JSXSpreadAttribute" && exposed(a.argument)
        )
      ? [node.loc?.start.line ?? 0]
      : [];
  });
}

Deno.test("context providers expose explicit ports, never composition props", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (!path.endsWith(".tsx")) continue;
    for (const line of leaks(text, path)) failures.push(`${path}:${line}`);
  }
  assertEquals(failures, []);
});

Deno.test("provider-port guard rejects aliases, implicit copies, rest copies and renamed contexts", () => {
  const start =
    `import {createContext as context} from 'solid-js'; const C = context();`;
  for (
    const body of [
      `return <C value={props}/>`,
      `const alias = props; return <C value={alias}/>`,
      `const copy = {...props}; return <C value={copy}/>`,
      `const copy = Object.assign({}, props); return <C value={copy}/>`,
      `const {children, ...ports} = props; return <C value={ports}/>`,
      `return <C {...props}/>`,
      `return <C value={{nested: props}}/>`,
      `return <C value={{get nested(){return props}}}/>`,
      `return <C value={props.children}/>`,
    ]
  ) {
    assert(
      leaks(`${start} function Provider(props){${body}}`).length > 0,
      body,
    );
  }
  assert(
    leaks(
      `import * as solid from 'solid-js'; const C = solid.createContext(); const Alias = C; function Provider(input){return <Alias value={input}/>}`,
    ).length > 0,
  );
  assert(
    leaks(
      `${start} function Provider({children, ...ports}){return <C value={ports}/>} `,
    ).length > 0,
  );
});

Deno.test("provider-port guard permits explicit live ports and unrelated DOM values", () => {
  for (
    const body of [
      `return <C value={props.ports}>{props.children}</C>`,
      `return <C value={{commands: props.commands}}>{props.children}</C>`,
      `const ports = {get commands(){return props.commands}}; return <C value={ports}>{props.children}</C>`,
      `return <C value={props.lease ?? null}>{props.children}</C>`,
      `return <input value={props}/>`,
    ]
  ) {
    assertEquals(
      leaks(
        `import {createContext} from 'solid-js'; const C = createContext(); function Provider(props){${body}}`,
      ),
      [],
      body,
    );
  }
});
