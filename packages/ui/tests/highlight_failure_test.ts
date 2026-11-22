// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { highlightBlock } from "../highlight/client.ts";
import type { HighlightToken } from "../highlight/types.ts";

Deno.test("a refused token projection resets only its block before a fresh capture", async () => {
  const source = "const intact = 7;";
  const block = highlightBlock("ts", source);
  try {
    await assertRejects(
      () =>
        block.capture({
          generation: 1,
          lang: "ts",
          text: source,
          streaming: false,
        }, () => {
          throw new Error("Token projection refused");
        }),
      Error,
      "Token projection refused",
    );
    const tokens: HighlightToken[] = [];
    await block.capture({
      generation: 2,
      lang: "ts",
      text: source,
      streaming: false,
    }, (chunk) => {
      tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    });
    assertEquals(tokens.map((token) => token.content).join(""), source);
  } finally {
    block.dispose();
  }
});

Deno.test("plain source never acquires enhancement capability and a refused worker cannot abort a block", async () => {
  const Native = globalThis.Worker, warn = console.warn;
  const refused = new TypeError("Module worker refused", {
    cause: new Error("HTTP 503"),
  });
  const diagnostics: unknown[][] = [];
  let constructions = 0;
  globalThis.Worker = class {
    constructor() {
      constructions++;
      throw refused;
    }
  } as unknown as typeof Worker;
  console.warn = (...args) => {
    diagnostics.push(args);
  };
  const plain = highlightBlock("text", "full plain source");
  const syntax = highlightBlock("sh", "echo full source");
  try {
    await plain.prepare("text");
    assertEquals(
      await plain.capture({
        generation: 1,
        lang: "text",
        text: "full plain source",
        streaming: false,
      }, () => {
        throw new Error("Plain source cannot need tokens");
      }),
      { plain: true },
    );
    assertEquals(constructions, 1);
    await assertRejects(
      () => syntax.prepare("sh"),
      TypeError,
      "Module worker refused",
    );
    await assertRejects(
      () =>
        syntax.capture({
          generation: 1,
          lang: "sh",
          text: "echo full source",
          streaming: false,
        }, () => {}),
      TypeError,
      "Module worker refused",
    );
    assertEquals(diagnostics.length, 1);
    assertEquals((diagnostics[0][2] as { error: Error }).error, refused);
    assertEquals(
      refused.cause instanceof Error && refused.cause.message,
      "HTTP 503",
    );
    const retiring = syntax.capture({
      generation: 2,
      lang: "sh",
      text: "echo retiring",
      streaming: false,
    }, () => {});
    syntax.focus([{ start: 0, end: 13 }]);
    syntax.cancel();
    await assertRejects(() => retiring, DOMException, "cancelled");
    assertEquals(
      constructions,
      1,
      "Focus and cancellation cannot acquire a refused capability",
    );
  } finally {
    plain.dispose();
    syntax.dispose();
    globalThis.Worker = Native;
    console.warn = warn;
  }
});
