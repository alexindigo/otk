// SPDX-License-Identifier: LGPL-3.0-only
// Private VM-only paired oracle. Promote meaningful coverage only after eligibility.
import { assert, assertEquals } from "@std/assert";
import { createCssVariablesTheme, createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { sharedNativeScanners } from "../highlight/scanners.ts";
import { bundledLanguages } from "shiki/langs";
import * as candidate from "../highlight/client.ts";
const cases = [
  {
    lang: "ts",
    lines: [
      "const café: number = 1;",
      "/* first",
      "continued é 😀",
      "*/",
      "const pattern = /[é]+/u;",
    ],
  },
  {
    lang: "tsx",
    lines: [
      "const view = <section title='é 😀'>",
      "  <b>{value}</b>",
      "</section>;",
      "const id = 1;",
      "",
    ],
  },
  {
    lang: "javascript",
    lines: [
      "const café = 1;",
      "/* first",
      "continued é 😀",
      "*/",
      "const template = `é ${café} 😀`;",
    ],
  },
  {
    lang: "python",
    lines: [
      "def café(x):",
      '\ttext = """first',
      "continued é 😀",
      'end"""',
      "\treturn f'{x}:é😀'",
      "",
    ],
  },
  {
    lang: "json",
    lines: [
      "{",
      '  "label": "é 😀 é",',
      '  "items": [1, 2, true],',
      '  "last": null',
      "}",
    ],
  },
  {
    lang: "bash",
    lines: [
      "#!/bin/sh",
      "cat <<'EOF'",
      "é 😀 literal",
      "EOF",
      "printf '%s\\n' \"$HOME\"",
    ],
  },
  {
    lang: "sql",
    lines: [
      "SELECT 'é 😀' AS label;",
      "/* first",
      "continued text",
      "*/",
      "SELECT COUNT(*) FROM records WHERE id = 1;",
    ],
  },
  {
    lang: "html",
    lines: [
      '<section title="é 😀">',
      "<!-- first",
      "continued text -->",
      "<b>value &amp; text</b>",
      "</section>",
    ],
  },
  {
    lang: "css",
    lines: [
      "a:hover {",
      "  --label: 'é 😀';",
      "  /* first",
      "  continued text */",
      "}",
    ],
  },
  {
    lang: "yaml",
    lines: ["title: é 😀", "items:", "  - one", "body: |", "  literal é\ttext"],
  },
  {
    lang: "diff",
    lines: [
      "--- a/source.ts",
      "+++ b/source.ts",
      "@@ -1 +1 @@",
      "-const old = 1;",
      "+const café = 'é 😀';",
    ],
  },
  {
    lang: "markdown",
    lines: [
      "**strong é 😀**",
      "*italic* [link](https://example.test)",
      "```ts",
      "const café = 1;",
      "```",
    ],
  },
] as const;
type Token = { content: string; color?: string; fontStyle?: number };
type Chunk = { from: number; tokens: Token[] };
const shape = ({ content, color, fontStyle }: Token) => ({
  content,
  color,
  fontStyle,
});
const canonical = (text: string) => text.replace(/\r\n|\r/g, "\n");
Deno.test("shared native compilation matches stock Oniguruma scopes, full captures, viewport context, append recall and cache across application languages", async () => {
  const languages = await Promise.all(
    cases.map(({ lang }) => bundledLanguages[lang]()),
  );
  const theme = () =>
    createCssVariablesTheme({
      name: "otk-dark",
      variablePrefix: "--otk-syntax-",
    });
  const onig = await createHighlighterCore({
    langs: languages,
    themes: [theme()],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  const js = await createHighlighterCore({
    langs: languages,
    themes: [theme()],
    engine: sharedNativeScanners(
      await createOnigurumaEngine(import("shiki/wasm")),
    ),
  });
  const owners: { dispose(): void }[] = [];
  try {
    for (const entry of cases) {
      const rows = Array.from(
        { length: 130 },
        (_, i) => entry.lines[i % entry.lines.length],
      );
      for (const ending of ["\n", "\r\n", "\r"]) {
        const source = rows.join(ending),
          label = entry.lang + ":" + JSON.stringify(ending);
        const options = {
          lang: entry.lang,
          theme: "otk-dark",
          includeExplanation: true,
        };
        const expectedRows =
          onig.codeToTokens(canonical(source), options).tokens;
        const actualRows = js.codeToTokens(canonical(source), options).tokens;
        assertEquals(
          actualRows.length,
          expectedRows.length,
          "Rich row count differs: " + label,
        );
        for (let row = 0; row < expectedRows.length; row++) {
          try {
            assertEquals(
              actualRows[row],
              expectedRows[row],
              "Rich token boundaries/scopes/colours/styles differ: " + label +
                ":row=" + row,
            );
          } catch (error) {
            console.info("FIRST_RICH_MISMATCH", {
              label,
              row,
              source: rows[row],
              actual: actualRows[row],
              expected: expectedRows[row],
            });
            throw error;
          }
        }
        assertEquals(
          actualRows.map((row) => row.map((token) => token.content).join(""))
            .join("\n"),
          source.replace(/\r\n|\r/g, "\n"),
          "Oracle source reconstruction: " + label,
        );
        if (entry.lang === "markdown") {
          assert(
            actualRows.flat().some((token) => (token.fontStyle || 0) & 2),
            "Missing genuine bold style",
          );
          assert(
            actualRows.flat().some((token) => (token.fontStyle || 0) & 1),
            "Missing genuine italic style",
          );
        }
        const flatten = (from: number, to: number) =>
          expectedRows.slice(from, to).flatMap((line, index) => [
            ...line.map(shape),
            ...(from + index < rows.length - 1
              ? [{ content: ending, color: undefined, fontStyle: undefined }]
              : []),
          ]);
        const outputs: Token[][] = [];
        for (const service of [candidate]) {
          const block = service.highlightBlock(entry.lang, source),
            full: Token[] = [];
          const start = rows.slice(0, 96).join(ending).length + ending.length;
          const end = rows.slice(0, 128).join(ending).length + ending.length;
          let projected = 0, beforeDense = false;
          const consume = (chunk: Chunk) => {
            assert(
              (chunk.tokens.map((token) => token.content).join("").match(
                /\r\n|\n|\r/g,
              )?.length || 0) <= 32,
              "Exceeded worker publication budget",
            );
            full.splice(chunk.from, full.length - chunk.from, ...chunk.tokens);
          };
          try {
            block.focus([{ start, end }]);
            await block.capture(
              {
                generation: 1,
                lang: entry.lang,
                text: source,
                streaming: false,
              },
              consume,
              (part: { start: number; tokens: Token[] }) => {
                assertEquals(part.start, start);
                assertEquals(
                  part.tokens,
                  flatten(96, 128),
                  "Far viewport context differs: " + label,
                );
                beforeDense = full.map((token) =>
                  token.content
                ).join("").length < end;
                projected++;
              },
            );
            assertEquals(
              projected,
              1,
              "Missing genuine viewport result: " + label,
            );
            assert(
              beforeDense,
              "Viewport waited for dense cold output: " + label,
            );
            assertEquals(
              full,
              flatten(0, 130),
              "Full worker capture differs: " + label,
            );
            assertEquals(full.map((token) => token.content).join(""), source);
            const initial = source + ending + "tail";
            await block.capture({
              generation: 2,
              lang: entry.lang,
              text: initial,
              streaming: true,
            }, consume);
            const final = initial + "Value é 😀";
            await block.capture({
              generation: 3,
              lang: entry.lang,
              text: final,
              streaming: false,
            }, consume);
            assertEquals(
              full.map((token) => token.content).join(""),
              final,
              "Append recall lost bytes: " + label,
            );
            const complete = full.map(shape);
            const finalRows =
              onig.codeToTokens(canonical(final), options).tokens;
            const endings = [...final.matchAll(/\r\n|\n|\r/g)].map((match) =>
              match[0]
            );
            const finalExpected = finalRows.flatMap((
              row,
              index,
            ) => [
              ...row.map(shape),
              ...(index < endings.length
                ? [{
                  content: endings[index],
                  color: undefined,
                  fontStyle: undefined,
                }]
                : []),
            ]);
            assertEquals(
              complete,
              finalExpected,
              "Appended full capture differs from Oniguruma: " + label,
            );
            const replay: Token[] = [];
            await block.capture({
              generation: 4,
              lang: entry.lang,
              text: final,
              streaming: false,
            }, (chunk: Chunk) =>
              replay.splice(
                chunk.from,
                replay.length - chunk.from,
                ...chunk.tokens,
              ));
            assertEquals(
              replay,
              complete,
              "Completed cache replay differs: " + label,
            );
            outputs.push(complete);
          } finally {
            owners.push(block);
          }
        }
        console.info("ENGINE_CORPUS_MATCH", label);
      }
    }
  } finally {
    for (const owner of owners) owner.dispose();
    js.dispose();
    onig.dispose();
  }
});
