// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { sharedNativeScanners } from "../../../web/src/highlight/scanners.ts";
Deno.test("native compiler owns repeated pattern sources once while preserving original ordinals", async () => {
  const native = await createOnigurumaEngine(import("shiki/wasm"));
  const compiled: string[][] = [];
  const engine = sharedNativeScanners({
    createString: native.createString,
    createScanner(values) {
      compiled.push(
        values.map((value) => typeof value === "string" ? value : value.source),
      );
      return native.createScanner(values);
    },
  });
  const patterns = ["(a)", "(a)", "(b)", String.raw`\A(c)`];
  const expected = native.createScanner(patterns),
    actual = engine.createScanner(patterns);
  try {
    for (const source of ["a", "b", "c", "é😀b"]) {
      const text = native.createString(source);
      try {
        for (let position = 0; position <= source.length; position++) {
          assertEquals(
            actual.findNextMatchSync(text, position, 0),
            expected.findNextMatchSync(text, position, 0),
          );
        }
      } finally {
        text.dispose?.();
      }
    }
    assertEquals(
      compiled.flat().filter((pattern) => pattern === "(a)").length,
      1,
      "Duplicate native bytecode was constructed",
    );
  } finally {
    actual.dispose?.();
    expected.dispose?.();
  }
});
Deno.test("native query bounds and compressed ordinals retain stock captures for scalar, surrogate and anchor positions", async () => {
  const native = await createOnigurumaEngine(import("shiki/wasm")),
    engine = sharedNativeScanners(native);
  const groups = [
    ["(.)", "(.)", String.raw`\A(.)`, String.raw`\G(.)`],
    ["(b)", String.raw`\A(a)`],
    [String.raw`\B`, String.raw`\A(\w+)`, "(😀)"],
    [String.raw`a\K(b)`, "a(b)", String.raw`\A(c)`],
  ];
  for (const patterns of groups) {
    const expected = native.createScanner(patterns),
      actual = engine.createScanner(patterns);
    try {
      for (
        const source of [
          "ab",
          "foo😀bar",
          "é_name",
          "😀a",
          "a\ud800b",
          "a\udc00b",
          "",
        ]
      ) {
        const text = native.createString(source);
        try {
          for (let position = -1; position <= source.length + 1; position++) {
            for (const options of [0, 1]) {
              assertEquals(
                actual.findNextMatchSync(text, position, options),
                expected.findNextMatchSync(text, position, options),
                JSON.stringify({ patterns, source, position, options }),
              );
              assertEquals(
                actual.findNextMatchSync(source, position, options),
                expected.findNextMatchSync(source, position, options),
              );
            }
          }
        } finally {
          text.dispose?.();
        }
      }
    } finally {
      actual.dispose?.();
      expected.dispose?.();
    }
  }
  const a = engine.createScanner(["(a)", "(a)", "(b)"]),
    b = engine.createScanner(["(a)", "(b)"]),
    text = native.createString("b");
  try {
    assertEquals(a.findNextMatchSync(text, 0, 0)?.index, 2);
    a.dispose?.();
    assertEquals(b.findNextMatchSync(text, 0, 0)?.index, 1);
  } finally {
    text.dispose?.();
    b.dispose?.();
  }
});
Deno.test("a first-ordinal native boundary winner resolves a query without later native searches", async () => {
  const native = await createOnigurumaEngine(import("shiki/wasm"));
  let searches = 0;
  const engine = sharedNativeScanners({
    createString: native.createString,
    createScanner(values) {
      const scanner = native.createScanner(values);
      return {
        findNextMatchSync(...args) {
          searches++;
          return scanner.findNextMatchSync(...args);
        },
        dispose() {
          scanner.dispose?.();
        },
      };
    },
  });
  const patterns = ["(a)", String.raw`\A(a)`],
    expected = native.createScanner(patterns),
    actual = engine.createScanner(patterns),
    text = native.createString("ab");
  try {
    assertEquals(
      actual.findNextMatchSync(text, 0, 0),
      expected.findNextMatchSync(text, 0, 0),
    );
    assertEquals(
      searches,
      1,
      "Native query continued after its earliest possible first-ordinal winner",
    );
  } finally {
    text.dispose?.();
    actual.dispose?.();
    expected.dispose?.();
  }
});
