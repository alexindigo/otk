// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { createCssVariablesTheme, createHighlighterCore } from "shiki/core";
import { bundledLanguages } from "shiki/langs";
import { sharedNativeScanners } from "../../../web/src/highlight/scanners.ts";

Deno.test("native grammar context variants share compilation without changing token scopes or styles", async () => {
  const native = await createOnigurumaEngine(import("shiki/wasm"));
  let stockPatterns = 0, sharedPatterns = 0;
  const observe = (shared: boolean) => ({
    createString: native.createString,
    createScanner(patterns: (string | RegExp)[]) {
      if (shared) sharedPatterns += patterns.length;
      else stockPatterns += patterns.length;
      return native.createScanner(patterns);
    },
  });
  const theme = () =>
    createCssVariablesTheme({
      name: "otk-dark",
      variablePrefix: "--otk-syntax-",
    });
  const language = await bundledLanguages.ts();
  const stock = await createHighlighterCore({
    langs: [language],
    themes: [theme()],
    engine: observe(false),
  });
  const shared = await createHighlighterCore({
    langs: [language],
    themes: [theme()],
    engine: sharedNativeScanners(observe(true)),
  });
  try {
    const source = Array.from(
      { length: 130 },
      (_, i) =>
        i === 30
          ? "/* starts"
          : i === 100
          ? "*/"
          : i > 30 && i < 100
          ? `continued é 😀 ${i}`
          : `const value${i}: number = ${i};`,
    ).join("\n");
    const options = { lang: "ts", theme: "otk-dark", includeExplanation: true };
    const expected = stock.codeToTokens(source, options).tokens,
      actual = shared.codeToTokens(source, options).tokens;
    assertEquals(actual.length, expected.length);
    for (let row = 0; row < expected.length; row++) {
      assertEquals(actual[row], expected[row], `Scope/style row${row}`);
    }
    assert(
      sharedPatterns < stockPatterns,
      "Unchanged grammar context patterns were still compiled twice",
    );
  } finally {
    shared.dispose();
    stock.dispose();
  }
});

Deno.test("native compiler leases preserve independent scanner disposal, ordering, Unicode and failure cleanup", async () => {
  const native = await createOnigurumaEngine(import("shiki/wasm"));
  let created = 0, ended = 0;
  const backend = {
    createString: native.createString,
    createScanner(patterns: (string | RegExp)[]) {
      const scanner = native.createScanner(patterns);
      created++;
      return {
        findNextMatchSync: scanner.findNextMatchSync.bind(scanner),
        dispose() {
          ended++;
          scanner.dispose?.();
        },
      };
    },
  };
  const engine = sharedNativeScanners(backend);
  const word = String.raw`\b([_[:alpha:]]\w*)\b`;
  const a = engine.createScanner([word, String.raw`\A(#!)`]),
    b = engine.createScanner([word, "\uffff(#!)"]);
  a.dispose?.();
  const text = native.createString("def café(x):");
  const oracle = native.createScanner([word, "\uffff(#!)"]);
  try {
    assertEquals(
      b.findNextMatchSync(text, 4, 0),
      oracle.findNextMatchSync(text, 4, 0),
    );
  } finally {
    text.dispose?.();
    oracle.dispose?.();
    b.dispose?.();
  }
  assertEquals(ended, created);
  for (
    const patterns of [[String.raw`\B`, String.raw`\A(\w+)`], [
      String.raw`\A(a)`,
      "(a)",
      String.raw`\G(a)`,
    ], [String.raw`a\K(b)`, "a(b)", String.raw`\A(c)`]]
  ) {
    const expected = native.createScanner(patterns),
      actual = engine.createScanner(patterns);
    try {
      for (const source of ["foo😀bar", "é_name", "ab", "c"]) {
        const input = native.createString(source);
        try {
          for (let start = 0; start <= source.length; start++) {
            assertEquals(
              actual.findNextMatchSync(input, start, 0),
              expected.findNextMatchSync(input, start, 0),
              JSON.stringify({ patterns, source, start }),
            );
          }
        } finally {
          input.dispose?.();
        }
      }
    } finally {
      actual.dispose?.();
      expected.dispose?.();
    }
  }
  assertEquals(ended, created);
  let allocated = 0, released = 0;
  const failing = sharedNativeScanners({
    createString: native.createString,
    createScanner(patterns) {
      if (allocated === 1) throw new Error("native backend unavailable");
      const scanner = native.createScanner(patterns);
      allocated++;
      return {
        findNextMatchSync: scanner.findNextMatchSync.bind(scanner),
        dispose() {
          released++;
          scanner.dispose?.();
        },
      };
    },
  });
  assertThrows(
    () => failing.createScanner(["word", String.raw`\Aother`]),
    Error,
    "native backend unavailable",
  );
  assertEquals(allocated, 1);
  assertEquals(released, 1, "Previous compiler lease leaked on failure");
});
