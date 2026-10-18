// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

function errors(name: string, source: string): string[] {
  if (name === "ToolPath.tsx" || name === "paths.ts") return [];
  const result: string[] = [];
  if (/\botk-path\b/.test(source)) {
    result.push("file labels belong to ToolPath");
  }
  const aliases = ["path", "cwd", "oldPath"];
  for (
    const match of source.matchAll(
      /\b(?:const|let)\s+(\w+)\s*=\s*(?:props\.)?(?:call|file(?:\(\))?)\.(?:path|oldPath|cwd)\b/g,
    )
  ) aliases.push(match[1]);
  const raw = new RegExp(
    `>\\s*\\{\\s*(?:(?:props\\.)?(?:call|file(?:\\(\\))?)\\.(?:path|oldPath|cwd)\\b|(?:${
      aliases.join("|")
    })\\b)`,
  );
  if (
    raw.test(source) ||
    /\{\s*`[^`]*\$\{(?:props\.)?(?:call|file(?:\(\))?)\.(?:path|oldPath|cwd)[^`]*`\s*\}/
      .test(source)
  ) {
    result.push("tool body renders a raw path");
  }
  if (
    /(?:\.outputPaths|\.outputContent\??\.paths)\s*\?*\.\s*(?:join|map)\s*\(/
      .test(source)
  ) {
    result.push(
      "path-list formatting belongs to ToolOutput and the path presenter",
    );
  }
  if (/function\s+relativeTarget\b/.test(source)) {
    result.push("duplicate path presenter");
  }
  for (
    const [, component, attrs] of source.matchAll(
      /<(ToolPath|Diff|ReadTool|SearchTool|EditTool|PatchTool)\b([\s\S]*?)\/>/g,
    )
  ) {
    if (!/\bdirectory=/.test(attrs)) {
      result.push(`${component} lost project context`);
    }
  }
  return result;
}
Deno.test("tool bodies and their diff labels cannot bypass the shared path presenter", async () => {
  const tools = new URL("../../packages/ui/components/tools/", import.meta.url);
  for await (const entry of Deno.readDir(tools)) {
    if (!/\.tsx?$/.test(entry.name)) continue;
    assertEquals(
      errors(entry.name, await Deno.readTextFile(new URL(entry.name, tools))),
      [],
      entry.name,
    );
  }
  assertEquals(
    errors("Diff.tsx", await Deno.readTextFile(new URL("../Diff.tsx", tools))),
    [],
  );
  const owner = await Deno.readTextFile(new URL("ToolPath.tsx", tools));
  assert(owner.includes("relativeTarget(props.path, props.directory)"));
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
