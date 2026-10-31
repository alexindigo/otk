// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Source } from "./analysis.ts";
import { literal, property } from "./syntax.ts";

function handRolled(
  source: string,
  path = "fixture.tsx",
  arrays = true,
  kinds = new Set(["upsert", "remove", "digest"]),
): boolean {
  const ast = new Source(source, path);
  return ast.all.some((node) => {
    if (
      arrays &&
      (node.type === "MemberExpression" ||
        node.type === "OptionalMemberExpression") &&
      property(node.property) === "ops"
    ) return true;
    if (
      arrays && node.type === "ObjectProperty" &&
      property(node.key) === "ops" &&
      ast.parent.get(node)?.type === "ObjectPattern"
    ) return true;
    if (
      arrays && node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      property(node.callee.object) === "Reflect" &&
      property(node.callee.property) === "get" &&
      literal(node.arguments[1]) === "ops"
    ) return true;
    if (node.type === "BinaryExpression") {
      const member = [node.left, node.right].find((value) =>
        value.type === "MemberExpression" && property(value.property) === "op"
      );
      return !!member &&
        [node.left, node.right].some((value) =>
          kinds.has(literal(value) ?? "")
        );
    }
    return node.type === "SwitchStatement" &&
      node.cases.some((branch) => kinds.has(literal(branch.test) ?? ""));
  });
}
const indexKinds = new Set(["upsert", "remove", "digest"]);
const inboxKinds = new Set([
  "project.upsert",
  "project.remove",
  "task.upsert",
  "task.remove",
  "seen",
  "finish",
  "templates",
  "discovery",
]);
function outsideOwner(path: string, source: string, arrays = true): boolean {
  if (path === "packages/client/index.ts") {
    return handRolled(source, path, false, inboxKinds);
  }
  if (path === "packages/client/inbox.ts") {
    return handRolled(source, path, false, indexKinds);
  }
  return handRolled(
    source,
    path,
    arrays,
    new Set([...indexKinds, ...inboxKinds]),
  );
}

Deno.test("index-op interpretation belongs only to the shared keyed-index owner", () => {
  const root = new URL("../../", import.meta.url);
  const violations: string[] = [];
  function walk(url: URL, prefix: string, arrays = true) {
    for (const item of Deno.readDirSync(url)) {
      if (["tests", "node_modules", "dist"].includes(item.name)) continue;
      const path = `${prefix}${item.name}`;
      if (item.isDirectory) {
        walk(
          new URL(encodeURIComponent(item.name) + "/", url),
          path + "/",
          arrays,
        );
      } else if (
        /\.tsx?$/.test(item.name)
      ) {
        try {
          if (
            outsideOwner(
              path,
              Deno.readTextFileSync(
                new URL(encodeURIComponent(item.name), url),
              ),
              arrays,
            )
          ) violations.push(path);
        } catch (cause) {
          throw new Error(`Index reduction source scan: ${path}`, { cause });
        }
      }
    }
  }
  for (const directory of ["core", "packages", "web"]) {
    walk(new URL(directory + "/", root), directory + "/");
  }
  // Support consumers may record unrelated content operations; only actual
  // index-kind interpretation is forbidden there, just as in production.
  walk(new URL("tests/support/", root), "tests/support/", false);
  assertEquals(violations.sort(), []);
});
Deno.test("index and inbox patch families are reduced only by their respective owners", () => {
  const inbox =
    'for(const op of frame.ops){switch(op.op){case "seen": marks[op.sessionID]=op.time;break;case "task.upsert": put(op.task)}}';
  const index =
    'for(const op of frame.ops){switch(op.op){case "upsert":put(op.entry);break;case "digest":patch(op.id)}}';
  assertEquals(outsideOwner("packages/client/inbox.ts", inbox), false);
  assertEquals(outsideOwner("packages/client/index.ts", index), false);
  assertEquals(outsideOwner("packages/client/duplicate-inbox.ts", inbox), true);
  assertEquals(outsideOwner("packages/client/index.ts", inbox), true);
  assertEquals(outsideOwner("packages/client/inbox.ts", index), true);
  for (
    const source of [
      'const changes=frame["ops"]; changes.forEach(apply)',
      "const {ops: changes}=frame; changes.forEach(apply)",
      'Reflect.get(frame,"ops").forEach(apply)',
      'if(op.op==="task.remove")drop(op.id)',
    ]
  ) {
    assertEquals(
      outsideOwner("packages/client/duplicate-inbox.ts", source),
      true,
      source,
    );
  }
});
Deno.test("index reduction guard rejects aliases, destructuring, computed reads and kind switches without matching comments or content ops", () => {
  for (
    const source of [
      'for(const change of frame.ops){if(change.op==="upsert")put(change.entry);else remove(change.id)}',
      'const operations=frame["ops"]; operations.forEach(apply)',
      "const {ops: operations}=frame; operations.forEach(apply)",
      'Reflect.get(frame,"ops").forEach(apply)',
      'switch(operation.op){case "digest": break; case "remove": remove(operation.id)}',
      'if(operation["op"]==="remove")drop(operation.id)',
    ]
  ) assertEquals(handRolled(source), true, source);
  for (
    const source of [
      "index.receive(server,frame)",
      'if(event.op==="permission.remove")clear(event.requestID)',
      '// frame.ops.forEach(apply)\nconst text="operation.op === remove";',
      'const frame={t:"index.patch",ops:changes};send(frame)',
    ]
  ) assertEquals(handRolled(source), false, source);
});
