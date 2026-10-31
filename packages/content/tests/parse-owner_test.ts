// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { Lexer } from "marked";
import { markdown, StreamBuffers, StreamingMarkdown } from "../mod.ts";

Deno.test("producer snapshots, flush and finish borrow one parsed revision", () => {
  const stream = new StreamingMarkdown("# Stable\n\nTail");
  const original = Lexer.prototype.lex;
  let calls = 0;
  Lexer.prototype.lex = function (text) {
    calls++;
    return original.call(this, text);
  };
  try {
    const first = stream.snapshot();
    assertEquals(calls, 1);
    for (let i = 0; i < 100; i++) {
      assertStrictEquals(stream.snapshot(), first);
      stream.flush();
    }
    assertStrictEquals(stream.finish(), first);
    assertEquals(calls, 1);
    stream.append(" continues\n\n## Next\n");
    const next = stream.snapshot();
    assertEquals(next.revision, first.revision + 1);
    assertStrictEquals(next.blocks[0], first.blocks[0]);
    assertEquals(next.blocks, markdown(stream.text));
    assertEquals(calls, 3); // one append parse plus the independent oracle
  } finally {
    Lexer.prototype.lex = original;
  }
});

Deno.test("all chunk boundaries retain GFM, reference and CRLF semantics", () => {
  const sources = [
    "# Heading\r\n\r\nFirst\rSecond\n\nTail",
    "[late][ref]\n\n# Heading\n\n[ref]: https://example.test\n",
    "Title\n---\n\n- one\n- two\n\nTail",
    "```ts\nconst a = 1\n```\n\nTail",
    "<div>plain HTML</div>\n\n![image][i]\n\n[i]: /image.png\n",
    "| A | B |\n|---|---|\n| 1 | 2 |\n",
  ];
  for (const source of sources) {
    const stream = new StreamingMarkdown();
    let published: import("@otk/protocol").Block[] = [];
    for (const character of source) {
      stream.append(character);
      const snapshot = stream.snapshot();
      assertEquals(snapshot.blocks, markdown(stream.text), stream.text);
      const update = stream.flush();
      published = [...published.slice(0, update.from), ...update.blocks];
      assertEquals(published, snapshot.blocks);
    }
    assertEquals(stream.finish().blocks, markdown(source));
    stream.replace("replacement\r\n");
    assertEquals(stream.snapshot().blocks, markdown(stream.text));
    stream.replace(stream.text + "suffix");
    assertEquals(stream.finish().blocks, markdown(stream.text));
  }
});

Deno.test("buffer snapshot, overlay, replay and completion share parsed blocks", () => {
  const buffers = new StreamBuffers();
  buffers.subscriptions("session", 1);
  buffers.upsert("session", "message", {
    kind: "text",
    id: "part",
    blocks: [],
    synthetic: false,
  }, "# Stable\n\nTail");
  const first = buffers.snapshot("part")!.part.blocks;
  const original = Lexer.prototype.lex;
  let calls = 0;
  Lexer.prototype.lex = function (text) {
    calls++;
    return original.call(this, text);
  };
  try {
    for (let i = 0; i < 100; i++) {
      assertStrictEquals(buffers.snapshot("part")!.part.blocks, first);
      const message = buffers.overlay({
        role: "assistant",
        id: "message",
        sessionID: "session",
        agent: "build",
        model: { provider: "fixture", model: "model" },
        time: { created: 1 },
        parts: [],
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
        interrupted: false,
      });
      const part = message.parts[0];
      assert(part.kind === "text");
      assertStrictEquals(part.blocks, first);
      buffers.replay("session", () => {});
    }
    buffers.complete("message", (_session, event) => {
      if (event.op === "part.upsert" && event.part.kind === "text") {
        assertStrictEquals(event.part.blocks, first);
      }
    });
    assertEquals(calls, 0);
  } finally {
    Lexer.prototype.lex = original;
    buffers.stop();
  }
});

Deno.test("growing unstable constructs report suffix parsing cost without disguising full reparses", () => {
  for (
    const [name, source] of [
      ["paragraph", "paragraph words ".repeat(4000)],
      ["fence", "```text\n" + "line\n".repeat(12000)],
      [
        "late-reference",
        "[pending][ref]\n\n" + "paragraph words ".repeat(4000) +
        "\n\n[ref]: /target\n",
      ],
    ]
  ) {
    const stream = new StreamingMarkdown();
    const original = Lexer.prototype.lex;
    let calls = 0, lexedChars = 0, maxParseMs = 0;
    Lexer.prototype.lex = function (text) {
      calls++;
      lexedChars += text.length;
      const start = performance.now();
      const result = original.call(this, text);
      maxParseMs = Math.max(maxParseMs, performance.now() - start);
      return result;
    };
    try {
      for (let i = 0; i < 100; i++) {
        stream.append(
          source.slice(
            Math.floor(i * source.length / 100),
            Math.floor((i + 1) * source.length / 100),
          ),
        );
        const parsed = stream.snapshot();
        assertStrictEquals(stream.snapshot(), parsed);
      }
      assertEquals(calls, 100);
    } finally {
      Lexer.prototype.lex = original;
    }
    assertEquals(stream.finish().blocks, markdown(source));
    console.info("PARSE measurement", {
      name,
      sourceChars: source.length,
      calls,
      lexedChars,
      maxParseMs,
    });
  }
});

Deno.test("native part completion borrows its parsed revision and retires source immediately", () => {
  const buffers = new StreamBuffers();
  const shell = {
    kind: "text" as const,
    id: "part",
    blocks: [],
    synthetic: false,
  };
  buffers.upsert("session", "message", shell, "# Heading\n\nTail");
  const first = buffers.snapshot("part")!.part.blocks;
  const original = Lexer.prototype.lex;
  let calls = 0;
  Lexer.prototype.lex = function (text) {
    calls++;
    return original.call(this, text);
  };
  try {
    assertEquals(
      buffers.finishPart("other", "message", shell, "foreign"),
      undefined,
    );
    const final = buffers.finishPart("session", "message", {
      ...shell,
      synthetic: true,
    }, "# Heading\n\nTail");
    assert(final?.kind === "text");
    assertStrictEquals(final.blocks, first);
    assertEquals(final.synthetic, true);
    assertEquals(calls, 0);
    assertEquals(buffers.size, 0);
    assertEquals(buffers.snapshot("part"), undefined);
    assertEquals(buffers.append("part", "late", () => {}), false);
  } finally {
    Lexer.prototype.lex = original;
    buffers.stop();
  }
});

Deno.test("unwatched completion releases source without parsing an unused body", () => {
  const buffers = new StreamBuffers();
  buffers.upsert("session", "message", {
    kind: "text",
    id: "part",
    blocks: [],
    synthetic: false,
  }, "Unobserved source".repeat(1000));
  const original = Lexer.prototype.lex;
  let calls = 0;
  Lexer.prototype.lex = function (text) {
    calls++;
    return original.call(this, text);
  };
  try {
    buffers.complete("message", () => {
      throw new Error("No viewer owns this body");
    });
    assertEquals(calls, 0);
    assertEquals(buffers.size, 0);
  } finally {
    Lexer.prototype.lex = original;
    buffers.stop();
  }
});
