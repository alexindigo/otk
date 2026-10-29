// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

function writes(path: string, text: string) {
  const source = new Source(text, path), failures: string[] = [];
  let owners = 0;
  for (const node of source.all) {
    const target = node.type === "AssignmentExpression"
      ? node.left
      : node.type === "UpdateExpression"
      ? node.argument
      : undefined;
    if (
      target?.type === "MemberExpression" &&
      ((target.property.type === "Identifier" && !target.computed &&
        target.property.name === "scrollTop") ||
        (target.property.type === "StringLiteral" &&
          target.property.value === "scrollTop"))
    ) {
      const functions: string[] = [];
      let parent = source.parent.get(node);
      while (parent) {
        if (parent.type === "FunctionDeclaration" && parent.id) {
          functions.push(parent.id.name);
        }
        parent = source.parent.get(parent);
      }
      if (
        path === "packages/ui/components/viewport.ts" &&
        functions[0] === "applyPosition" &&
        functions.includes("createViewportPosition")
      ) owners++;
      else failures.push("position write outside viewport owner");
    }
    if (node.type === "CallExpression") {
      const callee = source.name(node.callee) ?? "";
      if (
        /^packages\/ui\/components\/(?:VirtualList|SessionView|Message|viewport)\./
          .test(path) && /\.(scrollIntoView|scrollTo|scroll)$/.test(callee)
      ) failures.push("implicit position write outside viewport owner");
      if (
        callee === "Reflect.set" &&
        node.arguments[1]?.type === "StringLiteral" &&
        node.arguments[1].value === "scrollTop"
      ) failures.push("reflective position write");
      if (
        callee === "Object.assign" &&
        node.arguments.slice(1).some((arg) =>
          arg.type === "ObjectExpression" &&
          arg.properties.some((p) =>
            p.type === "ObjectProperty" &&
            ((p.key.type === "Identifier" && p.key.name === "scrollTop") ||
              (p.key.type === "StringLiteral" && p.key.value === "scrollTop"))
          )
        )
      ) failures.push("assigned position write");
    }
  }
  return { failures, owners };
}
Deno.test("one viewport owner alone applies root scroll position", async () => {
  const failures: string[] = [];
  let owners = 0;
  for (const [path, text] of await productionSources()) {
    if (!path.startsWith("packages/ui/") || !/\.tsx?$/.test(path)) continue;
    const result = writes(path, text);
    owners += result.owners;
    failures.push(...result.failures.map((value) => `${path}: ${value}`));
  }
  assertEquals(failures, []);
  assertEquals(owners, 1);
});
Deno.test("viewport ownership negatives catch direct, computed and implicit writers", () => {
  assertEquals(
    writes(
      "packages/ui/components/VirtualList.tsx",
      `root.scrollTop=3;root['scrollTop']+=2;root.scrollTo(0,2);bubble.scrollIntoView();Reflect.set(root,'scrollTop',3);Object.assign(root,{scrollTop:3});`,
    ).failures.length,
    6,
  );
  assertEquals(
    writes(
      "packages/ui/components/viewport.ts",
      `function other(){root.scrollTop=3;}`,
    ).failures,
    ["position write outside viewport owner"],
  );
});
