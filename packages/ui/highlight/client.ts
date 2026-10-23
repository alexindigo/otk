// SPDX-License-Identifier: LGPL-3.0-only
import type {
  HighlightChunk,
  HighlightCompletion,
  HighlightInput,
  HighlightRange,
  HighlightRequest,
  HighlightResult,
  HighlightToken,
} from "./types.ts";
import { lineBreakCount, sourceLine } from "./lines.ts";
import { HIGHLIGHT_GROUP_ROWS } from "./policy.ts";
let worker: Worker | undefined, nextBlock = 0, nextRequest = 0;
const users = new Set<() => void>();
const pending = new Map<
  number,
  {
    block: number;
    receive(value: HighlightResult): void;
    reject(error: Error): void;
  }
>();
const cache = new Map<string, HighlightToken[]>();
const pendingKeys = new Map<string, Map<string, Promise<string>>>();
let outgoing: { owner: Worker; requests: HighlightRequest[] } | undefined;
function post(owner: Worker, request: HighlightRequest) {
  if (outgoing?.owner === owner) {
    outgoing.requests.push(request);
    return;
  }
  const batch = { owner, requests: [request] };
  outgoing = batch;
  queueMicrotask(() => {
    if (outgoing === batch) outgoing = undefined;
    if (worker === owner) owner.postMessage(batch.requests);
  });
}
const cancelled = () =>
  new DOMException("Highlight capture cancelled", "AbortError");
function releaseWorker() {
  if (users.size) return;
  worker?.terminate();
  worker = undefined;
  outgoing = undefined;
  cache.clear();
  pendingKeys.clear();
  for (const request of [...pending.values()]) request.reject(cancelled());
  pending.clear();
}
/** A real rendering activity may own capability preparation before code arrives. */
export function highlightingScope(): () => void {
  const owner = () => {};
  let disposed = false;
  users.add(owner);
  connect();
  return () => {
    if (disposed) return;
    disposed = true;
    users.delete(owner);
    releaseWorker();
  };
}
function connect(lang?: string, source?: string, block?: number): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "otk-highlight:" + JSON.stringify({
      lang: lang || "text",
      block,
      text: source === undefined ? undefined : prefixSource(source),
    }),
  });
  worker.onmessage = ({ data }: MessageEvent<HighlightResult>) => {
    const request = pending.get(data.id);
    if (request?.block === data.block) request.receive(data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    const error = new Error(event.message || "Highlight worker unavailable");
    const failed = [...pending.values()];
    pending.clear();
    worker?.terminate();
    worker = undefined;
    outgoing = undefined;
    for (const reset of users) reset();
    for (const request of failed) request.reject(error);
  };
  return worker;
}
function key(lang: string, text: string): Promise<string> {
  const keys = pendingKeys.get(lang) || new Map<string, Promise<string>>();
  const current = keys.get(text);
  if (current) return current;
  const pending: Promise<string> = crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  ).then((digest) =>
    lang + ":" +
    Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0"))
      .join("")
  ).finally(() => {
    if (keys.get(text) === pending) keys.delete(text);
    if (!keys.size && pendingKeys.get(lang) === keys) pendingKeys.delete(lang);
  });
  keys.set(text, pending);
  pendingKeys.set(lang, keys);
  return pending;
}
const task = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
interface Capture {
  id: number;
  input: HighlightInput;
  progress(value: HighlightChunk): void;
  project?(value: { start: number; tokens: HighlightToken[] }): void;
  resolve(value: HighlightCompletion): void;
  reject(error: Error): void;
  cancelled: boolean;
}
function prefixSource(source: string): string {
  let end = 0;
  const carriage = source.includes("\r");
  for (
    let line = 0;
    line < HIGHLIGHT_GROUP_ROWS && end < source.length;
    line++
  ) {
    end = sourceLine(source, end, carriage).end;
  }
  return source.slice(0, end);
}
export function highlightBlock(lang?: string, source?: string) {
  const block = ++nextBlock;
  let disposed = false,
    active: Capture | undefined,
    queued: Capture | undefined;
  let tokens: HighlightToken[] = [];
  let focus: HighlightRange[] = [];
  const prepared = new Map<string, Promise<void>>();
  const reset = () => prepared.clear();
  users.add(reset);
  connect(lang, source, block);
  const send = (value: HighlightRequest) =>
    post(
      connect(
        "lang" in value ? value.lang : lang,
        "text" in value ? value.text : undefined,
        block,
      ),
      value,
    );
  const release = () => {
    for (const [id, request] of [...pending]) {
      if (request.block === block) {
        pending.delete(id);
        request.reject(cancelled());
      }
    }
    prepared.clear();
  };
  const abort = (capture: Capture) => {
    capture.cancelled = true;
    pending.delete(capture.id);
    send({ type: "cancel", block, generation: capture.input.generation });
    capture.reject(cancelled());
  };
  const prepare = (lang: string, source?: string): Promise<void> => {
    if (disposed) return Promise.reject(cancelled());
    const old = prepared.get(lang);
    if (old) return old;
    const id = ++nextRequest;
    const promise = new Promise<void>((resolve, reject) => {
      pending.set(id, {
        block,
        reject(error) {
          pending.delete(id);
          reject(error);
        },
        receive(value) {
          if (value.type === "ready" && value.lang === lang) {
            pending.delete(id);
            resolve();
          } else if (value.type === "error") {
            pending.delete(id);
            reject(new Error(value.error));
          }
        },
      });
      let text: string | undefined;
      if (source !== undefined) {
        text = prefixSource(source);
      }
      send({ type: "prepare", id, block, lang, text });
    });
    prepared.set(lang, promise);
    void promise.catch(() => {
      if (prepared.get(lang) === promise) prepared.delete(lang);
    });
    return promise;
  };
  const finish = (
    capture: Capture,
    value?: HighlightCompletion,
    error?: Error,
  ) => {
    pending.delete(capture.id);
    if (active !== capture || capture.cancelled) return;
    active = undefined;
    if (error) capture.reject(error);
    else capture.resolve(value || {});
    if (queued) {
      const next = queued;
      queued = undefined;
      start(next);
    }
  };
  const apply = (capture: Capture, chunk: HighlightChunk) => {
    if (chunk.from < 0 || chunk.from > tokens.length) {
      throw new Error("Invalid highlight recall");
    }
    tokens.splice(chunk.from, tokens.length - chunk.from, ...chunk.tokens);
    capture.progress(chunk);
  };
  const start = (capture: Capture) => {
    active = capture;
    void (async () => {
      const { input } = capture;
      const hash = input.streaming
        ? undefined
        : await key(input.lang, input.text);
      if (disposed || active !== capture || capture.cancelled) return;
      if (hash && cache.has(hash)) {
        const cached = cache.get(hash)!;
        cache.delete(hash);
        cache.set(hash, cached);
        release();
        send({ type: "dispose", block });
        let from = 0, lines = 0, batch: HighlightToken[] = [];
        // Cached data obeys the same progress budget, not a giant UI result.
        for (const token of cached) {
          batch.push(token);
          lines += lineBreakCount(token.content);
          if (lines >= HIGHLIGHT_GROUP_ROWS) {
            apply(capture, { from, tokens: batch });
            from += batch.length;
            batch = [];
            lines = 0;
            await task();
            if (disposed || active !== capture || capture.cancelled) return;
          }
        }
        apply(capture, { from, tokens: batch });
        finish(capture);
        return;
      }
      pending.set(capture.id, {
        block,
        reject(error) {
          finish(capture, undefined, error);
        },
        receive(value) {
          if (
            !("generation" in value) || value.generation !== input.generation ||
            active !== capture || capture.cancelled
          ) return;
          try {
            if (value.type === "error") {
              finish(capture, undefined, new Error(value.error));
              return;
            }
            if (value.type === "projection") {
              capture.project?.(value);
              return;
            }
            if (value.type !== "progress" && value.type !== "done") return;
            if (value.type === "done" && value.plain) tokens = [];
            else apply(capture, value);
            if (value.type === "done") {
              if (hash && !value.plain) {
                cache.set(hash, tokens.slice());
                if (cache.size > 500) cache.delete(cache.keys().next().value!);
              }
              finish(capture, { plain: value.plain });
            }
          } catch (error) {
            finish(capture, undefined, error as Error);
          }
        },
      });
      send({
        type: "capture",
        id: capture.id,
        block,
        ...input,
        focus: focus.filter((range) =>
          range.start >= 0 && range.end <= input.text.length
        ),
      });
    })().catch((error) => finish(capture, undefined, error));
  };
  return {
    prepare,
    focus(ranges: HighlightRange[]) {
      if (
        focus.length === ranges.length &&
        focus.every((range, i) =>
          range.start === ranges[i].start && range.end === ranges[i].end
        )
      ) return;
      focus = ranges.map((range) => ({ ...range }));
      if (active) {
        send({
          type: "focus",
          block,
          generation: active.input.generation,
          ranges: focus.filter((range) =>
            range.start >= 0 && range.end <= active!.input.text.length
          ),
        });
      }
    },
    capture(
      input: HighlightInput,
      progress: (value: HighlightChunk) => void,
      project?: (value: { start: number; tokens: HighlightToken[] }) => void,
    ): Promise<HighlightCompletion> {
      if (disposed) return Promise.reject(cancelled());
      return new Promise((resolve, reject) => {
        const capture: Capture = {
          id: ++nextRequest,
          input: Object.freeze({ ...input }),
          progress,
          project,
          resolve,
          reject,
          cancelled: false,
        };
        if (queued) {
          queued.cancelled = true;
          queued.reject(cancelled());
          queued = undefined;
        }
        if (
          active && active.input.lang === input.lang &&
          input.text.startsWith(active.input.text)
        ) {
          // Finish an append-compatible immutable boundary before promotion.
          // Thus all prefix replies are consumed before a new generation starts.
          queued = capture;
        } else {
          if (active) {
            const old = active;
            active = undefined;
            abort(old);
            tokens = [];
          }
          start(capture);
        }
      });
    },
    cancel() {
      if (active) {
        const old = active;
        active = undefined;
        abort(old);
      }
      if (queued) {
        queued.cancelled = true;
        queued.reject(cancelled());
        queued = undefined;
      }
    },
    dispose() {
      if (disposed) return;
      this.cancel();
      disposed = true;
      release();
      if (worker) post(worker, { type: "dispose", block });
      users.delete(reset);
      tokens = [];
      releaseWorker();
    },
  };
}
