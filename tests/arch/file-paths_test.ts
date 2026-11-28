// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { literal, property, type t } from "./syntax.ts";

const recognizer = "packages/client/file-paths.ts";
const protocol = "packages/protocol/local-files.ts";
const server = "core/files/local-files.ts";
const reader = "packages/client/file-facts.ts";
const commands = "packages/ui/features/file-paths.tsx";
const blocks = "packages/ui/components/Blocks.tsx";
const inlineImage = "packages/ui/components/InlineImage.tsx";
const imageSource = "packages/client/inline-images.ts";
const link = "packages/ui/components/PathLink.tsx";
const css = "packages/ui/components/PathLink.css";
const preview = "packages/ui/components/FilePreview.tsx";
const language = "packages/content/language.ts";
const recognizerSymbols = new Set([
  "pathSegments",
  "hrefPath",
  "textRuns",
  "folderCommand",
  "pathTooltip",
]);
const consumers = new Set([
  recognizer,
  blocks,
  link,
  commands,
  preview,
  imageSource,
]);
const presenterMounts = new Set([blocks, inlineImage]);
const limits = new Set([
  "MAX_STAT_PATHS",
  "MAX_PATH_CHARS",
  "MAX_PREVIEW_TEXT_BYTES",
  "MAX_PREVIEW_IMAGE_BYTES",
]);

function problems(path: string, text: string): string[] {
  const issues = new Set<string>();
  if (path !== link && path !== css && /\botk-path-link\b/.test(text)) {
    issues.add("presenter");
  }
  if (
    !/\.[cm]?[jt]sx?$/.test(path) ||
    !/PathLink|pathSegments|hrefPath|textRuns|folderCommand|pathTooltip|fileLanguage|MAX_(?:STAT|PATH|PREVIEW)|file\.(?:stat|preview)|Deno\.|node:fs/
      .test(text)
  ) return [...issues];
  const source = new Source(text, path);
  const checkDefinition = (name: string | undefined) => {
    if (!name) return;
    if (recognizerSymbols.has(name) && path !== recognizer) {
      issues.add("recognizer owner");
    }
    if (limits.has(name) && path !== protocol) issues.add("limits");
    if (name === "fileLanguage" && path !== language) issues.add("language");
  };
  function rpcPath(node: t.Node): boolean {
    if (
      node.type === "CallExpression" || node.type === "OptionalCallExpression"
    ) {
      return node.arguments.some(rpcPath);
    }
    const pieces = source.name(node)?.split(".");
    return !!pieces?.slice(1).some((part) =>
      part === "path" || part === "paths"
    );
  }
  for (const node of source.all) {
    if (
      node.type === "FunctionDeclaration" || node.type === "VariableDeclarator"
    ) {
      if (node.id?.type === "Identifier") checkDefinition(node.id.name);
    }
    if (
      node.type === "JSXOpeningElement" && !presenterMounts.has(path) &&
      (property(node.name) === "PathLink" ||
        (node.name.type === "JSXIdentifier" &&
          source.binding(node.name.name, node)?.module?.endsWith(
            "/PathLink.tsx",
          ) &&
          source.binding(node.name.name, node)?.exportName === "default"))
    ) issues.add("presenter mount");
    if (
      node.type !== "CallExpression" && node.type !== "OptionalCallExpression"
    ) continue;
    const callee = source.name(node.callee);
    const name = property(node.callee);
    if (
      name && !consumers.has(path) &&
      (recognizerSymbols.has(name) ||
        recognizerSymbols.has(source.binding(name, node)?.imported ?? ""))
    ) issues.add("recognizer consumer");
    const method = literal(node.arguments[0]);
    if (name === "call" || name === "start") {
      if (method === "file.stat" && path !== reader) issues.add("stat caller");
      if (method === "file.preview" && path !== commands) {
        issues.add("preview caller");
      }
    }
    if (
      path.startsWith("core/") && path !== server && callee &&
      /^Deno\.(?:readFile|readTextFile|open|realPath)$/.test(callee) &&
      node.arguments.some(rpcPath)
    ) issues.add("RPC filesystem boundary");
  }
  return [...issues];
}

Deno.test("file paths have one owner for each stage", async () => {
  const findings = Array.from(await productionSources()).flatMap((
    [path, text],
  ) => problems(path, text).map((issue) => `${path}: ${issue}`));
  assertEquals(findings, []);
});

Deno.test("file path policy catches misplaced owners and admits their consumers", () => {
  for (
    const [path, body, issue, owner] of [
      [blocks, "function pathSegments() {}", "recognizer owner", recognizer],
      [
        "packages/ui/another.ts",
        `import { hrefPath as local } from "@otk/client"; local(href);`,
        "recognizer consumer",
        blocks,
      ],
      [commands, `rpc.call("file.stat", p);`, "stat caller", reader],
      [reader, `rpc.call("file.preview", p);`, "preview caller", commands],
      ["packages/ui/another.css", `.otk-path-link {}`, "presenter", css],
      [
        preview,
        `import FilePath from "./PathLink.tsx"; export const view = <FilePath/>;`,
        "presenter mount",
        blocks,
      ],
      [
        "core/features/foreign.ts",
        `rpc.register("sample", { handler(ctx, p) { const file = p.path; return Deno.readFile(file); } });`,
        "RPC filesystem boundary",
        server,
      ],
      [commands, "function fileLanguage() {}", "language", language],
      [reader, "const MAX_STAT_PATHS = 64;", "limits", protocol],
    ] as const
  ) {
    assertEquals(problems(path, body), [issue], issue);
    assertEquals(problems(owner, body), [], issue);
  }
  assertEquals(
    problems("core/config/loader.ts", `Deno.readTextFile(path);`),
    [],
  );
  assertEquals(problems(inlineImage, "<PathLink mention={mention} />;"), []);
  assertEquals(problems(imageSource, "hrefPath(source);"), []);
});
