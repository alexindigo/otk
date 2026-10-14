// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { highlightBlock, highlightingScope } from "../highlight/client.ts";
import type { HighlightChunk, HighlightToken } from "../highlight/types.ts";
import { createCssVariablesTheme, createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";

Deno.test("highlight captures are fair, bounded, grammar-equivalent, cached and cancellation-safe", async () => {
  const theme = createCssVariablesTheme({
    name: "otk-dark",
    variablePrefix: "--otk-syntax-",
  });
  const core = await createHighlighterCore({
    langs: [await bundledLanguages.ts()],
    themes: [theme],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  let generation = 0;
  const source = Array.from(
    { length: 130 },
    (_, i) =>
      i === 30
        ? "/* open"
        : i === 66
        ? "*/"
        : i > 30 && i < 66
        ? `comment ${i}`
        : `const value${i}: number = ${i};`,
  ).join("\n");
  const a = highlightBlock("ts", source), b = highlightBlock("ts", source);
  const order: string[] = [];
  const apply = (tokens: HighlightToken[], chunk: HighlightChunk) => {
    assert(
      chunk.tokens.reduce(
        (n, token) => n + token.content.split("\n").length - 1,
        0,
      ) <= 32,
    );
    tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
  };
  try {
    await Promise.all([a.prepare("ts", source), b.prepare("ts", source)]);
    const first: HighlightToken[] = [], second: HighlightToken[] = [];
    await Promise.all([
      a.capture({
        generation: ++generation,
        lang: "ts",
        text: source,
        streaming: false,
      }, (chunk) => {
        order.push("a");
        apply(first, chunk);
      }),
      b.capture({
        generation: ++generation,
        lang: "ts",
        text: source,
        streaming: false,
      }, (chunk) => {
        order.push("b");
        apply(second, chunk);
      }),
    ]);
    assertEquals(first.map((token) => token.content).join(""), source);
    assertEquals(second, first);
    assert(
      order.indexOf("b") < order.lastIndexOf("a") &&
        order.indexOf("a") < order.lastIndexOf("b"),
      "One snapshot starved the other ready block",
    );
    const expected = core.codeToTokens(source, {
      lang: "ts",
      theme: "otk-dark",
    }).tokens.flatMap((line, i) =>
      i === 129 ? line : [...line, { content: "\n", offset: 0 }]
    ).map(({ content, color, fontStyle }) => ({ content, color, fontStyle }));
    assertEquals(
      first,
      expected,
      "Completed capture differs from full Shiki grammar output",
    );
    const cached: HighlightToken[] = [];
    await b.capture({
      generation: ++generation,
      lang: "ts",
      text: source,
      streaming: false,
    }, (chunk) => apply(cached, chunk));
    assertEquals(cached, first);
    let stopped = false;
    const cancelled = a.capture({
      generation: ++generation,
      lang: "ts",
      text: source + "\nnext",
      streaming: true,
    }, () => {
      if (!stopped) {
        stopped = true;
        a.cancel();
      }
    });
    await assertRejects(() => cancelled, DOMException, "cancelled");
    const replacement: HighlightToken[] = [];
    await a.capture({
      generation: ++generation,
      lang: "ts",
      text: "const replaced = 3;",
      streaming: false,
    }, (chunk) => apply(replacement, chunk));
    assertEquals(
      replacement.map((token) => token.content).join(""),
      "const replaced = 3;",
    );
    const unknown = await a.capture({
      generation: ++generation,
      lang: "otk-unknown-language",
      text: "plain",
      streaming: false,
    }, () => {
      throw new Error("Unknown source was styled");
    });
    assertEquals(unknown.plain, true);
  } finally {
    a.dispose();
    b.dispose();
    core.dispose();
  }
});

Deno.test("capture source preserves original line terminators including a split CRLF append", async () => {
  const block = highlightBlock();
  let generation = 0;
  try {
    await block.prepare("ts", "/* opening\r");
    for (const ending of ["\r\n", "\r", "\n"]) {
      const source =
        `const first = 1;${ending}/* comment${ending}continues */${ending}const last = 2;${ending}`;
      const tokens: HighlightToken[] = [];
      await block.capture(
        {
          generation: ++generation,
          lang: "ts",
          text: source,
          streaming: false,
        },
        (chunk) =>
          tokens.splice(
            chunk.from,
            tokens.length - chunk.from,
            ...chunk.tokens,
          ),
      );
      assertEquals(tokens.map((token) => token.content).join(""), source);
    }
    const tokens: HighlightToken[] = [];
    const first = "/* opening\r",
      final = first + "\ncontinued\r\n*/\r\nconst done = 3;";
    const progress = (chunk: HighlightChunk) =>
      tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    await block.capture({
      generation: ++generation,
      lang: "ts",
      text: first,
      streaming: true,
    }, progress);
    assertEquals(tokens.map((token) => token.content).join(""), first);
    await block.capture({
      generation: ++generation,
      lang: "ts",
      text: final,
      streaming: false,
    }, progress);
    assertEquals(tokens.map((token) => token.content).join(""), final);
  } finally {
    block.dispose();
  }
});

Deno.test("pending completed-source keys share admission without retaining a second cache", async () => {
  const source = Array.from(
    { length: 130 },
    (_, i) => `const value${i}: number = ${i};`,
  ).join("\n");
  const a = highlightBlock("ts", source), b = highlightBlock("ts", source);
  const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest"),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  const order: string[] = [],
    first: HighlightToken[] = [],
    second: HighlightToken[] = [];
  try {
    await Promise.all([a.prepare("ts", source), b.prepare("ts", source)]);
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
        const response = digest(...args);
        if (++calls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return await response;
      },
    });
    const consume =
      (owner: string, tokens: HighlightToken[]) => (chunk: HighlightChunk) => {
        order.push(owner);
        tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
      };
    await Promise.all([
      a.capture(
        { generation: 1, lang: "ts", text: source, streaming: false },
        consume("a", first),
      ),
      b.capture(
        { generation: 1, lang: "ts", text: source, streaming: false },
        consume("b", second),
      ),
    ]);
    assertEquals(calls, 1, "Identical pending source was hashed independently");
    assert(
      order.indexOf("b") < order.lastIndexOf("a") &&
        order.indexOf("a") < order.lastIndexOf("b"),
      "Ready captures did not share admission",
    );
    assertEquals(first.map((token) => token.content).join(""), source);
    assertEquals(second, first);
    const replay: HighlightToken[] = [];
    await a.capture(
      { generation: 2, lang: "ts", text: source, streaming: false },
      (chunk) =>
        replay.splice(chunk.from, replay.length - chunk.from, ...chunk.tokens),
    );
    assertEquals(
      calls,
      2,
      "Settled source key was retained beyond pending work",
    );
    assertEquals(replay, first);
  } finally {
    if (descriptor) Object.defineProperty(crypto.subtle, "digest", descriptor);
    else Reflect.deleteProperty(crypto.subtle, "digest");
    a.dispose();
    b.dispose();
  }
});

Deno.test("unpublished real source preparation cannot leak into a replacement or survive disposal", async () => {
  const source = Array.from(
    { length: 96 },
    (_, i) => i === 0 ? "/* original comment" : i === 63 ? "*/" : `row ${i}`,
  ).join("\n");
  const first = highlightBlock("ts", source),
    disposed = highlightBlock("ts", source);
  const tokens: HighlightToken[] = [];
  const core = await createHighlighterCore({
    langs: [await bundledLanguages.ts()],
    themes: [
      createCssVariablesTheme({
        name: "otk-dark",
        variablePrefix: "--otk-syntax-",
      }),
    ],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  try {
    await first.prepare("ts", source);
    await first.capture({
      generation: 1,
      lang: "ts",
      text: "const actualReplacement = 1;",
      streaming: false,
    }, (chunk) => {
      tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    });
    assertEquals(
      tokens.map((token) => token.content).join(""),
      "const actualReplacement = 1;",
    );
    assertEquals(
      tokens,
      core.codeToTokens("const actualReplacement = 1;", {
        lang: "ts",
        theme: "otk-dark",
      }).tokens[0].map(({ content, color, fontStyle }) => ({
        content,
        color,
        fontStyle,
      })),
    );
    const preparing = disposed.prepare("ts", source);
    disposed.dispose();
    await assertRejects(() => preparing, DOMException, "cancelled");
    first.cancel();
    tokens.length = 0;
    await first.capture({
      generation: 2,
      lang: "ts",
      text: "const latest = 2;",
      streaming: false,
    }, (chunk) => {
      tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    });
    assertEquals(
      tokens.map((token) => token.content).join(""),
      "const latest = 2;",
    );
  } finally {
    first.dispose();
    disposed.dispose();
    core.dispose();
  }
});

Deno.test("worker error and block disposal settle pending captures and allow a fresh worker", async () => {
  const Native = globalThis.Worker, created: Worker[] = [];
  globalThis.Worker = class extends Native {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      created.push(this);
    }
  };
  const block = highlightBlock();
  const source = Array.from({ length: 400 }, (_, i) => `const item${i} = ${i};`)
    .join("\n");
  try {
    await block.prepare("ts");
    let failed = false;
    const capture = block.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: true,
    }, () => {
      if (!failed) {
        failed = true;
        created[0].dispatchEvent(
          new ErrorEvent("error", {
            message: "owned worker failure",
            cancelable: true,
          }),
        );
      }
    });
    await assertRejects(() => capture, Error, "owned worker failure");
    const tokens: HighlightToken[] = [];
    await block.capture(
      { generation: 2, lang: "ts", text: "const fresh = 1;", streaming: false },
      (chunk) =>
        tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens),
    );
    assertEquals(
      tokens.map((token) => token.content).join(""),
      "const fresh = 1;",
    );
    assertEquals(created.length, 2);
    let disposed = false;
    const pending = block.capture({
      generation: 3,
      lang: "ts",
      text: source,
      streaming: true,
    }, () => {
      if (!disposed) {
        disposed = true;
        block.dispose();
      }
    });
    await assertRejects(() => pending, DOMException, "cancelled");
  } finally {
    block.dispose();
    globalThis.Worker = Native;
  }
});

Deno.test("a cached capture settles preparation even when the worker ready reply is delayed", async () => {
  const Native = globalThis.Worker;
  let hold = false;
  globalThis.Worker = class extends Native {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      this.addEventListener("message", (event) => {
        if (hold && event.data.type === "ready") {
          event.stopImmediatePropagation();
        }
      });
    }
  };
  const first = highlightBlock(), cached = highlightBlock();
  const source = "const cachedSource = 1;", tokens: HighlightToken[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await first.prepare("ts", source);
    await first.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: false,
    }, () => {});
    hold = true;
    const preparing = cached.prepare("ts", source);
    const preparation = assertRejects(
      () => preparing,
      DOMException,
      "cancelled",
    );
    await cached.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: false,
    }, (chunk) => {
      tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    });
    assertEquals(tokens.map((token) => token.content).join(""), source);
    await Promise.race([
      preparation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Preparation remained pending after cached disposal"),
            ),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    first.dispose();
    cached.dispose();
    globalThis.Worker = Native;
  }
});

Deno.test("viewport grammar priority matches full Shiki before dense cold output and retains full capture", async () => {
  const theme = createCssVariablesTheme({
    name: "otk-dark",
    variablePrefix: "--otk-syntax-",
  });
  const core = await createHighlighterCore({
    langs: [await bundledLanguages.ts(), await bundledLanguages.markdown()],
    themes: [theme],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  try {
    for (const lang of ["ts", "markdown"]) {
      const lines = Array.from(
        { length: 130 },
        (_, i) =>
          lang === "markdown"
            ? i % 7 === 0
              ? ""
              : `**strong ${i}** *italic* [linked](https://example.test/${i})`
            : i === 30
            ? "/* comment starts"
            : i === 100
            ? "*/"
            : i > 30 && i < 100
            ? `comment ${i} é 😀`
            : `const priority${i}: number = ${i};`,
      );
      const source = lines.join("\n"),
        start = lines.slice(0, 96).reduce((n, line) => n + line.length + 1, 0),
        end = lines.slice(0, 128).reduce((n, line) => n + line.length + 1, 0);
      const expectedLines =
        core.codeToTokens(source, { lang, theme: "otk-dark" }).tokens;
      const normalize = (
        rows: typeof expectedLines,
        offset: number,
        terminal: number,
      ) =>
        rows.flatMap((line, index) =>
          offset + index === terminal
            ? line
            : [...line, { content: "\n", offset: 0 }]
        ).map(({ content, color, fontStyle }) => ({
          content,
          color,
          fontStyle,
        }));
      const block = highlightBlock(lang, source),
        full: HighlightToken[] = [],
        projected: HighlightToken[][] = [];
      let beforeFull = false;
      try {
        block.focus([{ start, end }]);
        await block.capture({
          generation: 1,
          lang,
          text: source,
          streaming: false,
        }, (chunk) => {
          full.splice(chunk.from, full.length - chunk.from, ...chunk.tokens);
        }, (projection) => {
          assertEquals(projection.start, start);
          assertEquals(
            projection.tokens,
            normalize(expectedLines.slice(96, 128), 96, 129),
          );
          assert(
            projection.tokens.reduce(
              (n, token) => n + token.content.split("\n").length - 1,
              0,
            ) <= 32,
          );
          beforeFull = full.map((token) => token.content).join("").length < end;
          projected.push(projection.tokens);
        });
        assertEquals(projected.length, 1);
        assert(
          beforeFull,
          "Viewport data waited for every preceding cold token",
        );
        assertEquals(full, normalize(expectedLines, 0, 129));
      } finally {
        block.dispose();
      }
    }
  } finally {
    core.dispose();
  }
});

Deno.test("rendering preparation and genuine code share one worker and last real owner releases it", async () => {
  const Native = globalThis.Worker,
    created: Worker[] = [],
    ended: Worker[] = [];
  globalThis.Worker = class extends Native {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      created.push(this);
    }
    override terminate() {
      ended.push(this);
      super.terminate();
    }
  };
  const release = highlightingScope(),
    block = highlightBlock("ts", "const shared = 1;");
  const tokens: HighlightToken[] = [];
  try {
    await block.capture({
      generation: 1,
      lang: "ts",
      text: "const shared = 1;",
      streaming: false,
    }, (chunk) => {
      tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    });
    assertEquals(
      tokens.map((token) => token.content).join(""),
      "const shared = 1;",
    );
    assertEquals(created.length, 1);
    block.dispose();
    assertEquals(ended.length, 0);
    release();
    release();
    assertEquals(ended.length, 1);
    const leaveIdle = highlightingScope();
    assertEquals(created.length, 2);
    leaveIdle();
    assertEquals(ended.length, 2);
  } finally {
    block.dispose();
    release();
    globalThis.Worker = Native;
  }
});
