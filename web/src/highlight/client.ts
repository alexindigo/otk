// SPDX-License-Identifier: LGPL-3.0-only
import type {
  HighlightRequest,
  HighlightResult,
  HighlightToken,
} from "./types.ts";
let worker: Worker | undefined, users = 0, nextBlock = 0, nextRequest = 0;
const pending = new Map<
  number,
  { resolve(value: HighlightResult): void; reject(error: Error): void }
>();
const cache = new Map<string, HighlightToken[]>();
function connect(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }: MessageEvent<HighlightResult>) => {
    pending.get(data.id)?.resolve(data);
    pending.delete(data.id);
  };
  worker.onerror = (event) => {
    for (const request of pending.values()) {
      request.reject(
        new Error(event.message || "Highlight worker unavailable"),
      );
    }
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}
async function key(lang: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return lang + ":" +
    Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0"))
      .join("");
}
export function highlightBlock() {
  const block = ++nextBlock;
  users++;
  connect();
  let disposed = false;
  return {
    async update(
      lang: string,
      text: string,
      streaming: boolean,
    ): Promise<HighlightResult> {
      const hash = streaming ? undefined : await key(lang, text);
      if (disposed) throw new Error("Code block disposed");
      if (hash && cache.has(hash)) {
        const tokens = cache.get(hash)!;
        cache.delete(hash);
        cache.set(hash, tokens);
        worker?.postMessage({ dispose: block } satisfies HighlightRequest);
        return { id: 0, from: 0, tokens };
      }
      const socket = connect(), id = ++nextRequest;
      const result = await new Promise<HighlightResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.postMessage(
          { id, block, lang, text, streaming } satisfies HighlightRequest,
        );
      });
      if (hash && !result.error && !result.plain) {
        cache.set(hash, result.tokens);
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
      }
      return result;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      worker?.postMessage({ dispose: block } satisfies HighlightRequest);
      if (--users === 0) {
        worker?.terminate();
        worker = undefined;
        cache.clear();
        for (const request of pending.values()) {
          request.reject(new Error("Code view closed"));
        }
        pending.clear();
      }
    },
  };
}
