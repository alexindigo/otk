// SPDX-License-Identifier: LGPL-3.0-only
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type ThemedToken,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";
import { ShikiStreamTokenizer } from "@shikijs/stream";
import type {
  HighlightRequest,
  HighlightResult,
  HighlightToken,
} from "./types.ts";
const theme = createCssVariablesTheme({
  name: "otk-dark",
  variablePrefix: "--otk-syntax-",
});
const highlighter = createHighlighterCore({
  langs: [],
  themes: [theme],
  engine: createOnigurumaEngine(import("shiki/wasm")),
});
const streams = new Map<
  number,
  { lang: string; text: string; count: number; tokenizer: ShikiStreamTokenizer }
>();
const tokens = (items: ThemedToken[]): HighlightToken[] =>
  items.map(({ content, color, fontStyle }) => ({ content, color, fontStyle }));
async function highlight(
  request: Exclude<HighlightRequest, { dispose: number }>,
): Promise<HighlightResult> {
  const grammar =
    bundledLanguages[request.lang as keyof typeof bundledLanguages];
  if (!grammar) {
    streams.delete(request.block);
    return { id: request.id, from: 0, tokens: [], plain: true };
  }
  const [core, language] = await Promise.all([highlighter, grammar()]);
  if (!core.getLoadedLanguages().includes(request.lang)) {
    await core.loadLanguage(language);
  }
  if (!request.streaming) {
    streams.delete(request.block);
    const lines =
      core.codeToTokens(request.text, { lang: request.lang, theme: "otk-dark" })
        .tokens;
    return {
      id: request.id,
      from: 0,
      tokens: tokens(
        lines.flatMap((line, i) =>
          i === lines.length - 1
            ? line
            : [...line, { content: "\n", offset: 0 }]
        ),
      ),
    };
  }
  let stream = streams.get(request.block);
  if (
    !stream || stream.lang !== request.lang ||
    !request.text.startsWith(stream.text)
  ) {
    stream = {
      lang: request.lang,
      text: "",
      count: 0,
      tokenizer: new ShikiStreamTokenizer({
        highlighter: core,
        lang: request.lang,
        theme: "otk-dark",
      }),
    };
    streams.set(request.block, stream);
    const boundary = request.text.lastIndexOf("\n");
    if (boundary >= 0) {
      // A snapshot seed is bulk text, not N separately arriving chunks. Seed
      // completed lines once, then let stream own only the unfinished suffix.
      const prefix = core.codeToTokens(request.text.slice(0, boundary), {
        lang: request.lang,
        theme: "otk-dark",
      });
      stream.tokenizer.tokensStable = prefix.tokens.flatMap((line) => [
        ...line,
        { content: "\n", offset: 0 },
      ]);
      stream.tokenizer.lastStableGrammarState = prefix.grammarState;
      await stream.tokenizer.enqueue(request.text.slice(boundary + 1));
      const initial = tokens([
        ...stream.tokenizer.tokensStable,
        ...stream.tokenizer.tokensUnstable,
      ]);
      stream.text = request.text;
      stream.count = initial.length;
      return { id: request.id, from: 0, tokens: initial };
    }
  }
  const result = await stream.tokenizer.enqueue(
    request.text.slice(stream.text.length),
  );
  const from = stream.count - result.recall;
  const suffix = tokens([...result.stable, ...result.unstable]);
  stream.text = request.text;
  stream.count = from + suffix.length;
  return { id: request.id, from, tokens: suffix };
}
let queue = Promise.resolve();
globalThis.onmessage = (event: MessageEvent<HighlightRequest>) => {
  queue = queue.then(async () => {
    const request = event.data;
    if ("dispose" in request) {
      streams.delete(request.dispose);
      return;
    }
    try {
      globalThis.postMessage(await highlight(request));
    } catch (error) {
      globalThis.postMessage(
        {
          id: request.id,
          from: 0,
          tokens: [],
          error: (error as Error).message,
        } satisfies HighlightResult,
      );
    }
  });
};
