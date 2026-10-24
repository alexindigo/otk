// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { CodeProjection, sourceRange } from "../highlight/lines.ts";
import type { HighlightToken } from "../highlight/types.ts";

function build(model: CodeProjection) {
  while (!model.complete) {
    const next = model.build()!;
    assert(next.group.rows.length <= 32);
  }
  return model.groups.flatMap((group) => group.rows)
    .map((row) => row.text + row.ending).join("");
}
Deno.test("source projection preserves exact text, empty lines and stable prefix identity across recall", () => {
  const initial = "const a = 1;\n\nta";
  const model = new CodeProjection(initial, "ts");
  build(model);
  accept(model, initial, 0, [{
    content: "const a = 1;\n\n",
    color: "var(--keyword)",
  }, { content: "ta", color: "var(--fg)" }]);
  const first = model.groups[0].rows;
  const firstTokens = model.project(model.groups[0]);
  assert(model.append("const a = 1;\n\ntail"));
  build(model);
  accept(model, model.source, 1, [{
    content: "tail",
    color: "var(--fg)",
  }]);
  const next = model.groups[0].rows;
  assertStrictEquals(next[0], first[0]);
  assertStrictEquals(next[1], first[1]);
  assertNotStrictEquals(next[2], first[2]);
  assertEquals(next.map((row) => row.text + row.ending).join(""), model.source);
  assertEquals(next.map((row) => row.end), [13, 14, 18]);
  assertEquals(model.project(model.groups[0]), [
    [{ content: "const a = 1;", color: "var(--keyword)" }],
    [],
    [{ content: "tail", color: "var(--fg)" }],
  ]);
  assertEquals(firstTokens?.[2], [{ content: "ta", color: "var(--fg)" }]);
  const emptyLines = new CodeProjection("\n\n", "ts");
  assertEquals(build(emptyLines), "\n\n");
  assertEquals(emptyLines.groups[0].rows.map((row) => row.newline), [
    true,
    true,
    false,
  ]);
});
Deno.test("native source positions identify the exact bounded source group before row materialization", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const rows = Array.from(
      { length: 130 },
      (_, i) => (i % 31 === 0 ? "" : `row ${i} é 😀`) + ending,
    );
    const source = rows.join("");
    let offset = 0;
    for (const [i, row] of rows.entries()) {
      const group = Math.floor(i / 32) * 32;
      const range = sourceRange(source, offset);
      assertEquals(range, {
        start: rows.slice(0, group).join("").length,
        end: rows.slice(0, group + 32).join("").length,
      });
      assertEquals(
        source.slice(range.start, range.end),
        rows.slice(group, group + 32).join(""),
      );
      if (row.length > ending.length) {
        assertEquals(sourceRange(source, offset + 2), range);
      }
      offset += row.length;
    }
  }
  assertEquals(sourceRange("", 0), { start: 0, end: 0 });
});
function accept(
  model: CodeProjection,
  text: string,
  from: number,
  tokens: HighlightToken[],
  lang = model.lang,
) {
  for (const _ of model.accept(lang, text, from, tokens)) {
    /* bounded steps */
  }
}
Deno.test("a demanded source interval retains exact rows and identity when dense traversal adopts it", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const rows = Array.from({ length: 2000 }, (_, i) => `row ${i} é 😀`);
    const text = rows.join(ending);
    const model = new CodeProjection(text, "ts");
    model.build();
    const range = sourceRange(text, text.indexOf("row 1999"));
    const demanded = model.reserve(range.start);
    assert(demanded.rows.length <= 32);
    assertEquals(
      demanded.rows.map((row) => row.text + row.ending).join(""),
      text.slice(range.start, range.end),
    );
    assertEquals(model.groups.length, 1);
    assertStrictEquals(model.reserve(range.start), demanded);
    assertEquals(build(model), text);
    assertEquals(model.groups.length, Math.ceil(rows.length / 32));
    assertStrictEquals(model.groups.at(-1), demanded);
    const first = demanded.rows[0];
    assert(model.append(text + " appended" + ending + "new tail"));
    const appended = model.reserve(range.start);
    assertEquals(appended.key, demanded.key);
    assertStrictEquals(appended.rows[0], first);
    assertEquals(build(model), model.source);
    assertStrictEquals(model.groups.at(-1), appended);
  }
});
Deno.test("source rows retain complete blank/final bytes and prefix identity without tokens", () => {
  for (
    const source of [
      "",
      "\n",
      "a\n\n",
      "a\nb",
      Array.from({ length: 70 }, (_, i) => String(i)).join("\n"),
    ]
  ) {
    const model = new CodeProjection(source, "ts");
    assertEquals(build(model), source);
    assertEquals(
      model.groups.flatMap((group) => group.rows).length,
      source.split("\n").length,
    );
    const first = model.groups[0].rows[0];
    const whole = model.groups[0];
    assert(model.append(source + " appended\n"));
    assertEquals(build(model), source + " appended\n");
    if (first.newline) {
      assertEquals(model.groups[0].rows[0], first);
      assertStrictEquals(model.groups[0].rows[0], first);
    }
    if (whole.rows.length === 32 && whole.rows.at(-1)!.newline) {
      assertEquals(model.groups[0], whole);
      assertStrictEquals(model.groups[0], whole);
    }
    assertEquals(model.project(model.groups.at(-1)!), undefined);
  }
});

Deno.test("source coordinates preserve CRLF and CR endings through a split terminator", () => {
  for (const ending of ["\r\n", "\r", "\n"]) {
    const text = `a${ending}${ending}last${ending}`;
    const model = new CodeProjection(text, "ts");
    assertEquals(build(model), text);
    assertEquals(model.groups.flatMap((group) => group.rows).length, 4);
    assertEquals(model.groups[0].rows[0].ending, ending);
    accept(model, text, 0, [
      { content: "a", color: "one" },
      { content: ending },
      { content: ending },
      { content: "last", color: "two" },
      { content: ending },
    ]);
    assertEquals(
      model.project(model.groups[0])?.map((row) =>
        row.map((token) => token.content).join("")
      ),
      ["a", "", "last", ""],
    );
  }
  const model = new CodeProjection("a\r", "ts");
  build(model);
  const key = model.groups[0].key;
  assert(model.append("a\r\nb"));
  assertEquals(build(model), "a\r\nb");
  assertEquals(model.groups[0].key, key);
  assertEquals(model.groups[0].rows[0].fragments, ["a"]);
  assertEquals(model.groups[0].rows[0].ending, "\r\n");
});
Deno.test("token suffix recall decorates the same source rows, without changing raw identity", () => {
  const model = new CodeProjection("const recalledName\n\nlast", "ts");
  build(model);
  const group = model.groups[0], row = group.rows[0];
  const initial = [{ content: "const ", color: "keyword" }, {
    content: "recalled",
    color: "name",
  }];
  accept(model, "const recalled", 0, initial);
  assertEquals(model.project(group), undefined);
  accept(model, model.source, 1, [{
    content: "recalledName\n\nlast",
    color: "name",
  }]);
  assertEquals(model.project(group), [
    [{ content: "const ", color: "keyword" }, {
      content: "recalledName",
      color: "name",
    }],
    [],
    [{ content: "last", color: "name" }],
  ]);
  assertEquals(model.groups[0], group);
  assertStrictEquals(model.groups[0], group);
  assertEquals(model.groups[0].rows[0], row);
  assertStrictEquals(model.groups[0].rows[0], row);
  assertEquals(build(model), model.source);
});
Deno.test("source replacement and language boundaries reject stale tokens and preserve untouched groups", () => {
  const source = Array.from({ length: 96 }, (_, i) => `line${i}`).join("\n");
  const old = new CodeProjection(source, "ts");
  build(old);
  old.dirty.clear();
  accept(old, source.slice(0, source.indexOf("line32")), 0, [{
    content: source.slice(0, source.indexOf("line32")),
    color: "one",
  }]);
  assert(old.project(old.groups[0]));
  assertEquals(old.project(old.groups[2]), undefined);
  const replacement = new CodeProjection("replacement", "js");
  build(replacement);
  accept(replacement, source, 0, [{ content: source, color: "old" }], "ts");
  assertEquals(replacement.project(replacement.groups[0]), undefined);
  assertEquals(build(replacement), "replacement");
  assertEquals(old.append("replacement"), false);
});

Deno.test("unfinished source appends keep immutable fragment prefixes and layout keys across token epochs", () => {
  const source = new CodeProjection("const grow", "ts");
  build(source);
  const before = source.groups[0], fragments = before.rows[0].fragments;
  assert(source.append("const growName\nlater"));
  assertEquals(build(source), "const growName\nlater");
  assertEquals(source.groups[0].key, before.key);
  assertEquals(fragments, ["const grow"]);
  assertEquals(source.groups[0].rows[0].fragments, ["const grow", "Name"]);
  assert(Object.isFrozen(fragments));
  const next = new CodeProjection(source.source, "js", source);
  assertEquals(build(next), source.source);
  assertStrictEquals(next.groups[0], source.groups[0]);
  assert(next.id !== source.id);
  const replaced = new CodeProjection("replacement", "js", next);
  build(replaced);
  assert(replaced.groups[0].key !== next.groups[0].key);
});
