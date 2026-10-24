// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import {
  applyColorReplacements,
  createCssVariablesTheme,
  createHighlighterCore,
  resolveColorReplacements,
  type ThemedToken,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";
import { ShikiStreamTokenizer } from "@shikijs/stream";
import { EncodedTokenMetadata } from "shiki/textmate";
import { sourceLine } from "./lines.ts";
import { HIGHLIGHT_GROUP_ROWS } from "./policy.ts";
import { sharedNativeScanners } from "./scanners.ts";
import { instantiateOniguruma } from "./engine.ts";
import type {
  HighlightRange,
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
  // Shiki supplies the imports to our worker-owned native instantiator. The
  // pinned binary stays local and ephemeral, without a base64 module or a
  // persistent compilation cache.
  engine: createOnigurumaEngine(instantiateOniguruma).then(
    sharedNativeScanners,
  ),
});
interface Stream {
  lang: string;
  text: string;
  count: number;
  tokenizer: ShikiStreamTokenizer;
  closed: boolean;
}
const streams = new Map<number, Stream>();
const tokens = (items: ThemedToken[]): HighlightToken[] =>
  items.map(({ content, color, fontStyle }) => ({ content, color, fontStyle }));
async function appendCompleted(
  tokenizer: ShikiStreamTokenizer,
  delta: string,
  core: Awaited<ReturnType<typeof createHighlighterCore>>,
  lang: string,
) {
  const source = tokenizer.lastUnstableCodeChunk + delta;
  const endings: string[] = [];
  const carriage = source.includes("\r");
  let boundary = 0, contentEnd = 0;
  while (boundary < source.length) {
    const line = sourceLine(source, boundary, carriage);
    if (!line.ending) break;
    endings.push(line.ending);
    contentEnd = line.contentEnd;
    boundary = line.end;
  }
  if (!endings.length) return tokenizer.enqueue(delta);
  const recall = tokenizer.tokensUnstable.length;
  const prefix = core.codeToTokens(
    carriage
      ? source.slice(0, contentEnd).replace(/\r\n|\r/g, "\n")
      : source.slice(0, contentEnd),
    {
      lang,
      theme: "otk-dark",
      grammarState: tokenizer.lastStableGrammarState,
    },
  );
  const stable = prefix.tokens.flatMap((line, index) => [
    ...line,
    { content: endings[index], offset: 0 },
  ]);
  // The client owns the published token ledger/cache. This tokenizer needs
  // grammar/unfinished state and only the last ending for a split CRLF recall,
  // not a second growing copy of every already-published stable token.
  tokenizer.tokensStable = stable.slice(-1);
  tokenizer.lastStableGrammarState = prefix.grammarState;
  tokenizer.tokensUnstable = [];
  tokenizer.lastUnstableCodeChunk = "";
  const remainder = source.slice(boundary);
  // No source remains: avoid a second highlighter dispatch for a zero-byte
  // provisional tail. Grammar state already belongs to the completed prefix.
  const unstable = remainder
    ? (await tokenizer.enqueue(remainder)).unstable
    : [];
  return { recall, stable, unstable };
}
type Capture = Extract<HighlightRequest, { type: "capture" }>;
type Core = Awaited<ReturnType<typeof createHighlighterCore>>;
type NativeGrammar = ReturnType<Core["getLanguage"]>;
type NativeState = ReturnType<NativeGrammar["tokenizeLine2"]>["ruleStack"];
interface Job {
  request: Capture;
  carriage: boolean;
  core?: Core;
  focus: HighlightRange[];
  priority?: {
    position: number;
    state: NativeState;
    grammar: NativeGrammar;
    colors: string[];
    target?: HighlightRange;
    tokens: HighlightToken[];
  };
}
const alive = new Set<number>();
const jobs = new Map<number, Job>();
const prepared = new Map<string, Promise<Core | undefined>>();
interface Prefix {
  lang: string;
  text: string;
  ready: Promise<void>;
  stream?: Stream;
  tokens?: HighlightToken[];
}
const prefixes = new Map<number, Prefix>();
const ready: (() => Promise<void>)[] = [];
const channel = new MessageChannel();
let scheduled = false;
function prepare(lang: string) {
  const old = prepared.get(lang);
  if (old) return old;
  const grammar = bundledLanguages[lang as keyof typeof bundledLanguages];
  const loading = (async () => {
    if (!grammar) return;
    const [core, language] = await Promise.all([highlighter, grammar()]);
    if (!core.getLoadedLanguages().includes(lang)) {
      await core.loadLanguage(language);
    }
    return core;
  })();
  prepared.set(lang, loading);
  void loading.catch(() => {
    if (prepared.get(lang) === loading) prepared.delete(lang);
  });
  return loading;
}
function enqueue(job: Job) {
  if (jobs.get(job.request.block) !== job) return;
  enqueueTask(() =>
    advance(job).catch((error) => {
      const { request } = job;
      if (jobs.get(request.block) !== job) return;
      jobs.delete(request.block);
      streams.delete(request.block);
      prefixes.delete(request.block);
      reply({
        type: "error",
        id: request.id,
        block: request.block,
        generation: request.generation,
        error: errorMessage(error),
      });
    })
  );
}
function enqueueTask(task: () => Promise<void>) {
  ready.push(task);
  if (!scheduled) {
    scheduled = true;
    channel.port2.postMessage(null);
  }
}
function reply(value: HighlightResult) {
  globalThis.postMessage(value);
}
function streamFor(core: Core, lang: string): Stream {
  return {
    lang,
    text: "",
    count: 0,
    closed: false,
    tokenizer: new ShikiStreamTokenizer({
      highlighter: core,
      lang,
      theme: "otk-dark",
    }),
  };
}
function prepareSource(block: number, lang: string, source: string): Prefix {
  const prior = prefixes.get(block);
  if (prior && prior.lang === lang && prior.text === source) return prior;
  let end = 0;
  const carriage = source.includes("\r");
  for (
    let line = 0;
    line < HIGHLIGHT_GROUP_ROWS && end < source.length;
    line++
  ) {
    end = sourceLine(source, end, carriage).end;
  }
  const prefix: Prefix = {
    lang,
    text: source.slice(0, end),
    ready: Promise.resolve(),
  };
  prefixes.set(block, prefix);
  prefix.ready = prepare(lang).then((core) => {
    if (!core || prefixes.get(block) !== prefix) return;
    return new Promise<void>((resolve, reject) => {
      enqueueTask(async () => {
        try {
          if (prefixes.get(block) !== prefix) return;
          const stream = streamFor(core, lang);
          const result = prefix.text
            ? await appendCompleted(stream.tokenizer, prefix.text, core, lang)
            : { stable: [], unstable: [] };
          stream.text = prefix.text;
          prefix.tokens = tokens([...result.stable, ...result.unstable]);
          stream.count = prefix.tokens.length;
          prefix.stream = stream;
        } catch (error) {
          reject(error);
        } finally {
          resolve();
        }
      });
    });
  }).catch((error) => {
    if (prefixes.get(block) === prefix) prefixes.delete(block);
    throw error;
  });
  return prefix;
}
async function advance(job: Job) {
  const request = job.request;
  if (jobs.get(request.block) !== job) return;
  if (!job.core) {
    streams.delete(request.block);
    jobs.delete(request.block);
    prefixes.delete(request.block);
    reply({
      type: "done",
      id: request.id,
      block: request.block,
      generation: request.generation,
      from: 0,
      tokens: [],
      plain: true,
    });
    return;
  }
  let stream = streams.get(request.block);
  if (
    !stream || stream.lang !== request.lang ||
    !request.text.startsWith(stream.text) || stream.closed
  ) {
    const prefix = prefixes.get(request.block);
    prefixes.delete(request.block);
    if (
      prefix?.stream && prefix.lang === request.lang &&
      request.text.startsWith(prefix.text)
    ) {
      stream = prefix.stream;
      streams.set(request.block, stream);
      const done = stream.text === request.text;
      if (done && !request.streaming) {
        stream.tokenizer.tokensStable.push(...stream.tokenizer.close().stable);
        stream.closed = true;
      }
      if (done) jobs.delete(request.block);
      reply({
        type: done ? "done" : "progress",
        id: request.id,
        block: request.block,
        generation: request.generation,
        from: 0,
        tokens: prefix.tokens!,
      });
      if (!done) enqueue(job);
      return;
    }
    stream = streamFor(job.core, request.lang);
    streams.set(request.block, stream);
  }
  prefixes.delete(request.block);
  if (advanceViewport(job, stream)) {
    enqueue(job);
    return;
  }
  let end = stream.text.length;
  let joinedEnding = false;
  if (stream.text.endsWith("\r") && request.text[end] === "\n") {
    // A CR at the preceding capture boundary gains its LF, not a second line.
    const last = stream.tokenizer.tokensStable.at(-1)!;
    last.content = "\r\n";
    stream.text += "\n";
    end++;
    joinedEnding = true;
  }
  for (
    let line = 0;
    line < HIGHLIGHT_GROUP_ROWS && end < request.text.length;
    line++
  ) {
    end = sourceLine(request.text, end, job.carriage).end;
  }
  // A closed fence with unchanged source needs only tail finalization.
  const result = end === stream.text.length
    ? { recall: 0, stable: [], unstable: [] }
    : await appendCompleted(
      stream.tokenizer,
      request.text.slice(stream.text.length, end),
      job.core,
      request.lang,
    );
  const from = stream.count - result.recall - (joinedEnding ? 1 : 0);
  const suffix = tokens([
    ...(joinedEnding ? [{ content: "\r\n", offset: 0 }] : []),
    ...result.stable,
    ...result.unstable,
  ]);
  stream.text = request.text.slice(0, end);
  stream.count = from + suffix.length;
  if (jobs.get(request.block) !== job) return;
  if (end === request.text.length) {
    if (!request.streaming) {
      const tail = stream.tokenizer.close();
      stream.tokenizer.tokensStable.push(...tail.stable);
      stream.closed = true;
    }
    jobs.delete(request.block);
    reply({
      type: "done",
      id: request.id,
      block: request.block,
      generation: request.generation,
      from,
      tokens: suffix,
    });
  } else {
    reply({
      type: "progress",
      id: request.id,
      block: request.block,
      generation: request.generation,
      from,
      tokens: suffix,
    });
    enqueue(job);
  }
}
/** Context traversal never needs to serialize cold styled token objects first. */
function advanceViewport(job: Job, stream: Stream): boolean {
  const { request, core } = job;
  const future = job.focus.filter((range) =>
    range.start >= stream.text.length && range.end > range.start &&
    range.end <= request.text.length
  );
  if (!future.length) return false;
  if (!job.priority) {
    const grammar = core!.getLanguage(request.lang);
    const { theme, colorMap } = core!.setTheme("otk-dark");
    const replacements = resolveColorReplacements(theme, {});
    const state = stream.tokenizer.lastStableGrammarState?.getInternalStack() ??
      core!.getLastGrammarState("", { lang: request.lang, theme: "otk-dark" })
        .getInternalStack();
    if (!state) throw new Error("Highlight grammar has no context state");
    let position = stream.text.length -
      stream.tokenizer.lastUnstableCodeChunk.length;
    if (stream.text.endsWith("\r") && request.text[position] === "\n") {
      position++;
    }
    job.priority = {
      position,
      state,
      grammar,
      colors: colorMap.map((color) =>
        applyColorReplacements(color, replacements)
      ),
      tokens: [],
    };
  }
  const priority = job.priority;
  const end = Math.max(...future.map((range) => range.end));
  if (priority.position >= end) return false;
  for (
    let count = 0;
    count < HIGHLIGHT_GROUP_ROWS && priority.position < end;
    count++
  ) {
    const start = priority.position,
      line = sourceLine(request.text, start, job.carriage),
      text = request.text.slice(start, line.contentEnd);
    const target = future.find((range) => range.start === start);
    if (target) {
      priority.target = target;
      priority.tokens = [];
    }
    if (text) {
      // The same native grammar, initial/context state and 500 ms line limit as
      // Shiki's _tokenizeWithTheme; cold metadata stays within this one turn.
      const result = priority.grammar.tokenizeLine2(text, priority.state, 500);
      priority.state = result.ruleStack;
      if (priority.target) {
        for (let i = 0; i < result.tokens.length; i += 2) {
          const from = result.tokens[i],
            stop = i + 2 < result.tokens.length
              ? result.tokens[i + 2]
              : text.length;
          if (from === stop) continue;
          const metadata = result.tokens[i + 1];
          priority.tokens.push({
            content: text.slice(from, stop),
            color:
              priority.colors[EncodedTokenMetadata.getForeground(metadata)],
            fontStyle: EncodedTokenMetadata.getFontStyle(metadata),
          });
        }
      }
    }
    if (priority.target && line.ending) {
      priority.tokens.push({
        content: line.ending,
        color: undefined,
        fontStyle: undefined,
      });
    }
    priority.position = line.end;
    if (priority.target && priority.position >= priority.target.end) {
      reply({
        type: "projection",
        id: request.id,
        block: request.block,
        generation: request.generation,
        start: priority.target.start,
        tokens: priority.tokens,
      });
      priority.target = undefined;
      priority.tokens = [];
    }
  }
  return true;
}
channel.port1.onmessage = () => {
  scheduled = false;
  const task = ready.shift();
  if (!task) return;
  // Each turn advances one block by at most one source group. Other ready blocks
  // and incoming cancellation/preparation messages run before continuation.
  void task().finally(() => {
    if (ready.length && !scheduled) {
      scheduled = true;
      channel.port2.postMessage(null);
    }
  });
};
function receive(request: HighlightRequest) {
  if (request.type === "dispose") {
    alive.delete(request.block);
    jobs.delete(request.block);
    streams.delete(request.block);
    prefixes.delete(request.block);
    return;
  }
  if (request.type === "cancel") {
    prefixes.delete(request.block);
    if (jobs.get(request.block)?.request.generation === request.generation) {
      jobs.delete(request.block);
    }
    return;
  }
  if (request.type === "focus") {
    const job = jobs.get(request.block);
    if (job?.request.generation === request.generation) {
      job.focus = request.ranges;
    }
    return;
  }
  alive.add(request.block);
  if (request.type === "prepare") {
    const loading = request.text === undefined
      ? prepare(request.lang)
      : prepareSource(request.block, request.lang, request.text).ready;
    void loading.then(() => {
      if (alive.has(request.block)) {
        reply({
          type: "ready",
          id: request.id,
          block: request.block,
          lang: request.lang,
        });
      }
    }).catch((error) => {
      if (alive.has(request.block)) {
        reply({
          type: "error",
          id: request.id,
          block: request.block,
          error: errorMessage(error),
        });
      }
    });
    return;
  }
  const job: Job = {
    request,
    carriage: request.text.includes("\r"),
    focus: request.focus || [],
  };
  jobs.set(request.block, job);
  const prefix = prefixes.get(request.block);
  if (
    prefix && (prefix.lang !== request.lang ||
      !request.text.startsWith(prefix.text))
  ) prefixes.delete(request.block);
  void Promise.all([
    prepare(request.lang),
    prefixes.get(request.block)?.ready,
  ]).then(([core]) => {
    if (jobs.get(request.block) !== job) return;
    job.core = core;
    enqueue(job);
  }).catch((error) => {
    if (jobs.get(request.block) !== job) return;
    jobs.delete(request.block);
    prefixes.delete(request.block);
    reply({
      type: "error",
      id: request.id,
      block: request.block,
      generation: request.generation,
      error: errorMessage(error),
    });
  });
}
globalThis.onmessage = (
  event: MessageEvent<HighlightRequest | HighlightRequest[]>,
) => {
  for (const request of Array.isArray(event.data) ? event.data : [event.data]) {
    receive(request);
  }
};
// The first ordinary acquisition supplies its genuine bounded source context.
// Preparation can start during bootstrap; only a matching ordinary capture may
// publish it after the incoming coalescer. There is no independent worker user.
const declaration: unknown = Reflect.get(globalThis, "name");
if (
  typeof declaration === "string" && declaration.startsWith("otk-highlight:")
) {
  try {
    const context = JSON.parse(declaration.slice("otk-highlight:".length));
    if (typeof context.lang !== "string") {
      throw new Error("Invalid highlight declaration");
    }
    const loading = typeof context.block === "number" &&
        typeof context.text === "string"
      ? prepareSource(context.block, context.lang, context.text).ready
      : prepare(context.lang);
    void loading.catch((error) =>
      console.error("Highlight preparation:", error)
    );
  } catch (error) {
    console.error("Highlight declaration:", error);
  }
}
