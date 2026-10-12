// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { highlightBlock } from "../../../web/src/highlight/client.ts";
import type {
  HighlightRequest,
  HighlightToken,
} from "../../../web/src/highlight/types.ts";

Deno.test("ready captures are admitted together before bounded traversal and preserve fair full output", async () => {
  const Native = globalThis.Worker, envelopes: HighlightRequest[][] = [];
  globalThis.Worker = class extends Native {
    override postMessage(message: unknown, transfer: Transferable[]): void;
    override postMessage(
      message: unknown,
      options?: StructuredSerializeOptions,
    ): void;
    override postMessage(
      message: unknown,
      options: Transferable[] | StructuredSerializeOptions = [],
    ) {
      envelopes.push(
        (Array.isArray(message) ? message : [message]) as HighlightRequest[],
      );
      if (Array.isArray(options)) super.postMessage(message, options);
      else super.postMessage(message, options);
    }
  };
  const source = Array.from(
    { length: 130 },
    (_, i) =>
      i === 30
        ? "/* start"
        : i === 66
        ? "*/"
        : i > 30 && i < 66
        ? `comment ${i}`
        : `const source${i} = ${i};`,
  ).join("\n");
  const a = highlightBlock("ts", source), b = highlightBlock("ts", source);
  const order: string[] = [],
    first: HighlightToken[] = [],
    second: HighlightToken[] = [];
  try {
    await Promise.all([a.prepare("ts", source), b.prepare("ts", source)]);
    const consume =
      (name: string, tokens: HighlightToken[]) =>
      (chunk: { from: number; tokens: HighlightToken[] }) => {
        order.push(name);
        tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
      };
    await Promise.all([
      a.capture(
        { generation: 1, lang: "ts", text: source, streaming: true },
        consume("a", first),
      ),
      b.capture(
        { generation: 1, lang: "ts", text: source, streaming: true },
        consume("b", second),
      ),
    ]);
    assert(
      envelopes.some((envelope) =>
        envelope.filter((request) => request.type === "capture").length === 2
      ),
      "Ready cohort was exposed as independently admitted snapshots",
    );
    assert(
      order.indexOf("b") < order.lastIndexOf("a") &&
        order.indexOf("a") < order.lastIndexOf("b"),
      "Ready cohort traversal was not fair",
    );
    assertEquals(first.map((token) => token.content).join(""), source);
    assertEquals(second, first);
  } finally {
    a.dispose();
    b.dispose();
    globalThis.Worker = Native;
  }
});

Deno.test("queued capture cancellation and disposal precede traversal while another owner keeps the worker", async () => {
  const source = Array.from(
    { length: 130 },
    (_, i) => `const cancelled${i} = ${i};`,
  ).join("\n");
  const cancelled = highlightBlock("ts", source),
    current = highlightBlock("ts", source);
  let late = 0;
  const tokens: HighlightToken[] = [];
  try {
    await Promise.all([
      cancelled.prepare("ts", source),
      current.prepare("ts", source),
    ]);
    const pending = cancelled.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: true,
    }, () => late++);
    const rejection = assertRejects(() => pending, DOMException, "cancelled");
    cancelled.dispose();
    await current.capture(
      {
        generation: 1,
        lang: "ts",
        text: "const current = 1;",
        streaming: true,
      },
      (chunk) =>
        tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens),
    );
    await rejection;
    assertEquals(late, 0, "Disposed queued capture revived its consumer");
    assertEquals(
      tokens.map((token) => token.content).join(""),
      "const current = 1;",
    );
  } finally {
    cancelled.dispose();
    current.dispose();
  }
});
