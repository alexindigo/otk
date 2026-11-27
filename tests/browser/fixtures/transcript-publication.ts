// SPDX-License-Identifier: LGPL-3.0-only
import type { BrowserContext } from "@playwright/test";
import type { ClientFrame, IntentIdentity, Message } from "@otk/protocol";

const observed = new WeakSet<BrowserContext>();
/** Observe delivered public source, not native completion or an index lamp. */
export async function observeTranscript(context: BrowserContext) {
  if (observed.has(context)) return;
  observed.add(context);
  await context.addInitScript(() => {
    const Native = WebSocket;
    const globals = globalThis as typeof globalThis & {
      transcriptPublication: Map<string, Message>;
    };
    globals.transcriptPublication = new Map();
    // Chunks name the admitted intent, not a transport attempt. A result can
    // settle that intent via a replacement socket at the same endpoint.
    const streamed = new Set<string>();
    const releasedBySocket = new WeakMap<WebSocket, Set<string>>();
    const identity = (endpoint: string, ref: IntentIdentity) =>
      JSON.stringify([endpoint, ref.clientID, ref.window, ref.key]);
    globalThis.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        // Connection resolves "ws" relative to its (possibly prefixed) API base.
        const endpoint = new URL(this.url);
        if (!endpoint.pathname.endsWith("/api/ws")) return;
        const released = new Set<string>();
        releasedBySocket.set(this, released);
        this.addEventListener("close", () => released.clear(), {
          once: true,
        });
        this.addEventListener("message", (event) => {
          const frame = JSON.parse(event.data);
          let messages: Message[] = [];
          if (frame.t === "load.chunk" && frame.data.kind === "message-page") {
            if (!frame.data.page) return;
            const key = identity(endpoint.href, frame.request);
            if (streamed.has(key) || released.has(key)) return;
            streamed.add(key);
            messages = frame.data.page.items;
          } else if (frame.t === "request.result") {
            const key = identity(endpoint.href, frame.ref);
            // A streamed result advances coverage only; its older snapshot
            // must not overwrite a live part published after the page.
            if (streamed.delete(key) || released.delete(key)) return;
            if (frame.outcome.ok) messages = frame.outcome.result?.items ?? [];
          } else if (frame.t === "request.rejected") {
            // These rejections leave the client request open for recovery.
            if (
              frame.error.code !== "request.receipt-reset" &&
              !(frame.error.code === "request.input-required" &&
                frame.error.retry === "same-intent")
            ) streamed.delete(identity(endpoint.href, frame.ref));
          } else if (
            frame.t === "content" && frame.event.op === "message.upsert"
          ) {
            messages = [frame.event.message];
          }
          for (const message of messages) {
            if (
              typeof message.id === "string" && Array.isArray(message.parts)
            ) {
              const previous = globals.transcriptPublication.get(message.id);
              globals.transcriptPublication.set(message.id, {
                ...message,
                // Public message upserts can be header-only; parts have their
                // own events and are not withdrawn by an empty header array.
                parts: message.parts.length
                  ? message.parts
                  : previous?.parts ?? [],
              });
            }
          }
          if (frame.t === "content" && frame.event.op === "part.upsert") {
            const message = globals.transcriptPublication.get(
              frame.event.messageID,
            );
            if (message) {
              message.parts = message.parts.filter((part) =>
                part.id !== frame.event.part.id
              );
              message.parts.push(frame.event.part);
            }
          }
        });
      }

      override send(data: Parameters<WebSocket["send"]>[0]): void {
        super.send(data);
        const released = releasedBySocket.get(this);
        if (!released || !streamed.size || typeof data !== "string") {
          return;
        }
        let frame: ClientFrame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (frame?.t !== "request.release") return;
        for (const ref of frame.refs) {
          const key = identity(this.url, ref);
          // Released reads need not settle. Keep only a socket-local marker
          // for a terminal frame that was already in flight when they released.
          if (streamed.delete(key)) released.add(key);
        }
      }
    };
  });
}
