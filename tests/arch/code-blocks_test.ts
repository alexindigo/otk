// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

const ui = "packages/ui/";
const block = ui + "components/CodeBlock.tsx";
const code = ui + "components/Code.tsx";
const diff = ui + "components/Diff.tsx";
const actions = ui + "components/MessageActions.tsx";
const textOwner = "packages/client/code-blocks.ts";
const commands = ui + "features/code-blocks.tsx";
const shellTags = new Set(["bash", "sh", "shell", "zsh", "console"]);

function problems(path: string, text: string): string[] {
  if (!path.startsWith("packages/") || !/\.tsx?$/.test(path)) return [];
  const source = new Source(text, path);
  const errors: string[] = [];
  for (const node of source.all) {
    if (!source.live(node)) continue;
    if (
      node.type === "JSXOpeningElement" && path !== code && path !== block &&
      (node.name.type === "JSXIdentifier" && node.name.name === "pre" ||
        source.string(source.attr(node, "as")) === "pre")
    ) errors.push("frame");
    if (
      node.type === "ImportDeclaration" &&
      node.source.value.endsWith("/Code.tsx") && path !== block
    ) {
      errors.push("renderer");
    }
    if (
      node.type === "ArrayExpression" && path !== textOwner &&
      node.elements.length > 1 &&
      node.elements.every((item) =>
        item?.type === "StringLiteral" && shellTags.has(item.value)
      )
    ) errors.push("shell tags");
    if (
      node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" &&
      node.name.name === "button" &&
      path !== actions && source.attr(node, "data-message-command")
    ) errors.push("action buttons");
  }
  if (
    path === diff &&
    !/<For\s+each=\{props\.file\.hunks\}[\s\S]*?\{\(hunk\) => \(\s*<CodeBlock\b/
      .test(text)
  ) errors.push("hunk frame");
  if (
    path !== textOwner &&
    /\.filter\([\s\S]*?\.kind\s*!==\s*["'](?:add|del)["'][\s\S]*?\.map\([\s\S]*?\.text\)\.join\(/
      .test(text)
  ) errors.push("hunk source");
  if (
    source.calls("contextTarget").some((call) =>
      /\bkind:\s*["']diff["']/.test(text.slice(call.start!, call.end!))
    )
  ) errors.push("diff context");
  if (path !== commands) {
    for (const name of ["codeCopyText", "codeRunText"]) {
      if (source.calls(name).length) errors.push("text derivation");
    }
  }
  return errors;
}

Deno.test("one owner each for the code frame, renderer, copy and run rules", async () => {
  const files = await productionSources();
  assertEquals(
    [...files].flatMap(([path, text]) =>
      problems(path, text).map((error) => `${path}: ${error}`)
    ),
    [],
  );
});

Deno.test("code owner guard rejects independent block implementations", () => {
  const elsewhere = ui + "components/tools/Sample.tsx";
  for (
    const [path, text, error, owner, good] of [
      [
        elsewhere,
        "const x = <pre>example</pre>",
        "frame",
        block,
        "const x = <pre>example</pre>",
      ],
      [
        elsewhere,
        'import Code from "../Code.tsx";',
        "renderer",
        block,
        'import Code from "./Code.tsx";',
      ],
      [
        diff,
        "const x = <For each={props.file.hunks}>{(hunk) => (<div />)}</For>",
        "hunk frame",
        diff,
        "const x = <For each={props.file.hunks}>{(hunk) => (<CodeBlock />)}</For>",
      ],
      [
        elsewhere,
        'xs.filter((x) => x.kind !== "del").map(x => x.text).join("\\n")',
        "hunk source",
        textOwner,
        'xs.filter((x) => x.kind !== "del").map(x => x.text).join("\\n")',
      ],
      [
        elsewhere,
        'contextTarget(() => ({ kind: "diff" }))',
        "diff context",
        block,
        'contextTarget(() => ({ kind: "code" }))',
      ],
      [
        elsewhere,
        '["bash", "sh"]',
        "shell tags",
        textOwner,
        'new Set(["bash", "sh"])',
      ],
      [
        elsewhere,
        "codeCopyText(source)",
        "text derivation",
        commands,
        "codeCopyText(source)",
      ],
      [
        elsewhere,
        '<button data-message-command="code.copy"><CopyIcon /></button>',
        "action buttons",
        actions,
        '<button data-message-command="code.copy"><CopyIcon /></button>',
      ],
    ]
  ) {
    assertEquals(problems(path, text), [error]);
    assertEquals(problems(owner, good), []);
  }
});
