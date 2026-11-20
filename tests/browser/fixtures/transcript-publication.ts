// SPDX-License-Identifier: LGPL-3.0-only
import type { BrowserContext } from "@playwright/test";

const observed = new WeakSet<BrowserContext>();
/** Observe delivered public source, not native completion or an index lamp. */
export async function observeTranscript(context: BrowserContext) {
  if (observed.has(context)) return;
  observed.add(context);
  await context.addInitScript(() => {
    const Native = WebSocket;
    const globals = globalThis as typeof globalThis & {
      transcriptPublication: Map<string, import("@otk/protocol").Message>;
    };
    globals.transcriptPublication = new Map();
    globalThis.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          const frame = JSON.parse(event.data);
          const messages = frame.t === "load.chunk" &&
              frame.data.kind === "message-page"
            ? frame.data.page?.items ?? []
            : frame.t === "request.result" && frame.outcome.ok
            ? frame.outcome.result?.items ?? []
            : frame.t === "content" && frame.event.op === "message.upsert"
            ? [frame.event.message]
            : [];
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
    };
  });
}
