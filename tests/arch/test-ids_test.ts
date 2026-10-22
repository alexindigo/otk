// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { literal, nodes, parse, property } from "./syntax.ts";

function duplicateIds(files: ReadonlyMap<string, string>): string[] {
  const ids = new Map<string, string>();
  const errors: string[] = [];
  for (const [path, source] of files) {
    for (const node of nodes(parse(source, path))) {
      if (node.type !== "CallExpression" || property(node.callee) !== "test") {
        continue;
      }
      const input = node.arguments[0];
      const field = input?.type === "ObjectExpression"
        ? input.properties.find((p) =>
          p.type === "ObjectProperty" && property(p.key) === "name"
        )
        : undefined;
      const name = literal(
        field?.type === "ObjectProperty" ? field.value : input,
      );
      if (!name) continue;
      const id = /^([A-Z][\w-]*\d+)\s/.exec(name)?.[1];
      if (!id) continue;
      const previous = ids.get(id);
      if (previous) errors.push(`${id}: ${previous} and ${path}`);
      else ids.set(id, path);
    }
  }
  return errors;
}

Deno.test("numbered test IDs are unique across the integration suite", async () => {
  const files = new Map<string, string>();
  const root = new URL("../integration/", import.meta.url);
  async function read(directory: URL, prefix = ""): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix + entry.name;
      const url = new URL(
        encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory) await read(url, path + "/");
      else if (entry.name.endsWith("_test.ts")) {
        files.set(path, await Deno.readTextFile(url));
      }
    }
  }
  await read(root);
  assertEquals(duplicateIds(files), []);
});

Deno.test("test ID checks include scoped declarations, object names and nested suite files, not examples", () => {
  assertEquals(
    duplicateIds(
      new Map([
        [
          "one_test.ts",
          'test("I14 first", () => {}); // test("I14 example", fn)',
        ],
        ["nested/two_test.ts", "Deno.test({name: `I14 second`, fn() {}})"],
      ]),
    ),
    ["I14: one_test.ts and nested/two_test.ts"],
  );
  assertEquals(
    duplicateIds(
      new Map([
        [
          "one_test.ts",
          'test("I14 first", fn); test("I15 second", fn); const example = \'test("I14 example", fn)\';',
        ],
      ]),
    ),
    [],
  );
});
