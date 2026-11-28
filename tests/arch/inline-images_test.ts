// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { literal, nodes, property } from "./syntax.ts";

function checkedOpenFlags(path: string, text: string): string[] {
  const source = new Source(text, path);
  const read = source.all.find((node) =>
    node.type === "FunctionDeclaration" && node.id?.name === "read"
  );
  if (read?.type !== "FunctionDeclaration") return [];
  return [...nodes(read.body)].flatMap((node) => {
    if (
      node.type !== "CallExpression" || node.callee.type !== "Identifier" ||
      node.callee.name !== "open" || !node.arguments[1]
    ) return [];
    return [...nodes(node.arguments[1])].flatMap((flag) =>
      flag.type === "MemberExpression" && property(flag.object) === "constants"
        ? [property(flag.property) ?? ""]
        : []
    );
  });
}

Deno.test("the shared LocalFiles descriptor open is nonblocking and does not follow symlinks", async () => {
  const path = "core/files/local-files.ts";
  const flags = ["O_RDONLY", "O_NONBLOCK", "O_NOFOLLOW"];
  const fixture = 'function read() { return open("/fixture", ';
  assertEquals(
    checkedOpenFlags(path, `${fixture}constants.O_RDONLY); }`),
    ["O_RDONLY"],
  );
  const source = await Deno.readTextFile(
    new URL(`../../${path}`, import.meta.url),
  );
  assertEquals(checkedOpenFlags(path, source).sort(), flags.sort());
});

function violations(path: string, text: string): string[] {
  if (path.endsWith(".css")) return [];
  const source = new Source(text, path);
  const errors: string[] = [];
  for (const node of source.all) {
    if (
      node.type === "CallExpression" && node.callee.type === "MemberExpression"
    ) {
      const method = property(node.callee.property);
      if (
        path.startsWith("core/") &&
        (method === "imageBytes" || method === "imageFacts") &&
        path !== "core/files/inline-images.ts"
      ) errors.push("LocalFiles transport owner");
      if (
        method === "call" && node.arguments[0] &&
        literal(node.arguments[0]) === "file.images" &&
        path !== "packages/client/file-facts.ts"
      ) errors.push("FileFacts RPC owner");
    }
    if (
      path === "packages/ui/components/Blocks.tsx" &&
      node.type === "JSXOpeningElement" &&
      node.name.type === "JSXIdentifier" && node.name.name === "img"
    ) errors.push("InlineImage presenter");
  }
  if (
    path === "core/http/routes/api/inline-image/get.ts" &&
    !text.includes("app.inlineImages")
  ) {
    errors.push("InlineImages HTTP owner");
  }
  return errors;
}

Deno.test("inline image policy, transport, client facts and markdown have distinct owners", async () => {
  for (const [path, text] of await productionSources()) {
    assertEquals(violations(path, text), [], path);
  }
  assertEquals(
    violations("core/http/other.ts", "files.imageBytes(roots, path);"),
    ["LocalFiles transport owner"],
  );
  assertEquals(
    violations("core/files/inline-images.ts", "files.imageBytes(roots, path);"),
    [],
  );
  assertEquals(
    violations("packages/client/view.ts", 'rpc.call("file.images", params);'),
    ["FileFacts RPC owner"],
  );
  assertEquals(
    violations(
      "packages/client/file-facts.ts",
      'rpc.call("file.images", params);',
    ),
    [],
  );
  assertEquals(
    violations("packages/ui/components/Blocks.tsx", "const image = <img />;"),
    ["InlineImage presenter"],
  );
  assertEquals(
    violations(
      "packages/ui/components/Blocks.tsx",
      "const image = <InlineImage />;",
    ),
    [],
  );
});
