// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";

function delegated(text: string, path = "fixture.tsx") {
  const source = new Source(text, path);
  const dynamic = new Set(
    source.all.flatMap((node) =>
      node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
        node.init?.type === "CallExpression" &&
        source.imported(node.init.callee)?.name === "dynamic" &&
        source.imported(node.init.callee)?.module === "@solidjs/web"
        ? [source.binding(node.id.name, node)]
        : []
    ),
  );
  const failures: string[] = [];
  for (const node of source.all) {
    if (node.type !== "JSXOpeningElement") continue;
    const isDynamic = dynamic.has(source.access(node.name)?.binding);
    const native = node.name.type === "JSXIdentifier" &&
      /^[a-z]/.test(node.name.name);
    if (!native && !isDynamic) continue;
    for (const attribute of node.attributes) {
      if (
        isDynamic && attribute.type === "JSXAttribute" &&
        /^on[A-Z]/.test(property(attribute.name) ?? "")
      ) {
        failures.push(`dynamic handler:${node.loc?.start.line}`);
      }
      if (attribute.type !== "JSXSpreadAttribute") continue;
      const value = source.value(attribute.argument);
      const imported = value?.type === "CallExpression"
        ? source.imported(value.callee)
        : undefined;
      if (
        imported && ["selection", "toggle"].includes(imported.name) &&
        imported.module.endsWith("selection.ts")
      ) continue;
      const access = source.access(attribute.argument);
      const call = access?.binding.value;
      const owner = call?.type === "CallExpression"
        ? source.imported(call.callee)
        : undefined;
      if (
        access?.fields.join(".") !== "attributes" ||
        owner?.name !== "nativeAttributes" ||
        !owner.module.endsWith("native-attributes.ts")
      ) {
        failures.push(`implicit native spread:${node.loc?.start.line}`);
        continue;
      }
      const ref = source.attr(node, "ref");
      assert(ref, "Native attribute ports require their listener lifetime ref");
      if (
        ![...nodes(ref)].some((n) => {
          const target = source.access(n);
          return source.live(n) && target?.binding === access.binding &&
            target.fields.join(".") === "ref";
        })
      ) failures.push(`unbound native listener port:${node.loc?.start.line}`);
    }
  }
  return failures;
}
function nativeCompiler(text: string) {
  const source = new Source(text, "vite.config.ts");
  const field = (node: t.Node | undefined, key: string) => {
    const value = source.value(node);
    if (value?.type !== "ObjectExpression") return;
    return value.properties.find((p): p is t.ObjectProperty =>
      p.type === "ObjectProperty" && property(p.key) === key
    )?.value;
  };
  return source.all.some((node) => {
    if (
      node.type !== "CallExpression" ||
      source.imported(node.callee)?.module !== "@solidjs/vite-plugin"
    ) return false;
    const option = source.value(
      field(field(node.arguments[0], "solid"), "delegateEvents"),
    );
    return option?.type === "BooleanLiteral" && option.value === false;
  });
}
Deno.test("native DOM bindings have no implicit delegated handler path", async () => {
  const failures: string[] = [];
  for (const [path, text] of await uiSources()) {
    if (path.endsWith(".tsx")) {
      failures.push(
        ...delegated(text, path).map((error) => `${path}:${error}`),
      );
    }
  }
  assertEquals(failures, []);
  assert(
    nativeCompiler(
      await Deno.readTextFile(
        new URL("../../web/vite.config.ts", import.meta.url),
      ),
    ),
  );
});
Deno.test("native event guard rejects raw spreads, dynamic handlers and missing lifetime refs", () => {
  assert(
    delegated(`function C(props){return <textarea {...props}/>} `).length > 0,
  );
  assert(
    delegated(
      `import {dynamic as tag} from '@solidjs/web'; const Button = tag(()=>'button'); function C(props){return <Button onClick={props.run}/>} `,
    ).length > 0,
  );
  assert(
    delegated(
      `import {nativeAttributes} from './native-attributes.ts'; function C(props){const native = nativeAttributes(()=>props);return <textarea {...native.attributes} ref={props.ref}/>} `,
    ).length > 0,
  );
  assertEquals(
    nativeCompiler(
      `import solid from '@solidjs/vite-plugin'; solid({compiler:'native'})`,
    ),
    false,
  );
  assertEquals(
    nativeCompiler(
      `import solid from '@solidjs/vite-plugin'; solid({solid:{delegateEvents:true}})`,
    ),
    false,
  );
});
Deno.test("native event guard accepts explicit port/ref composition and data-only selection ports", () => {
  assertEquals(
    delegated(
      `import {nativeAttributes as attrs} from './native-attributes.ts'; function C(props){const native = attrs(()=>props);return <textarea {...native.attributes} ref={[props.ref,native.ref]}/>} `,
    ),
    [],
  );
  assertEquals(
    delegated(
      `import {selection} from './selection.ts'; function C(){return <button {...selection({selected:true})}/>} `,
    ),
    [],
  );
  assert(
    nativeCompiler(
      `import plugin from '@solidjs/vite-plugin'; plugin({compiler:'native',solid:{delegateEvents:false}})`,
    ),
  );
});
