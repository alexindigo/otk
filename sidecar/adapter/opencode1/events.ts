// SPDX-License-Identifier: LGPL-3.0-only
import type { Envelope } from "./types.ts";
import { envelopeType } from "./envelope.ts";
export async function consumeEvents(
  response: Response,
  bytes: () => void,
  event: (envelope: Envelope) => void | Promise<void>,
  accept?: (type: string) => boolean,
): Promise<void> {
  if (!response.body) throw new Error("SSE body missing");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let fragments: string[] = [], data: string[] = [], skipLF = false;
  async function line(text: string): Promise<void> {
    if (text === "") {
      if (data.length) {
        const raw = data.join("\n");
        data = [];
        if (accept) {
          const type = envelopeType(raw);
          if (type !== undefined && !accept(type)) return;
        }
        await event(JSON.parse(raw) as Envelope);
      }
    } else if (text.startsWith("data:")) {
      data.push(text.slice(5).replace(/^ /, ""));
    }
  }
  async function chunk(text: string): Promise<void> {
    if (!text) return;
    let start = 0;
    if (skipLF) {
      if (text[0] === "\n") start = 1;
      skipLF = false;
    }
    // Scan new bytes once. Repeatedly concatenating/re-scanning an incomplete
    // multi-megabyte SSE line makes allocations quadratic in its length.
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch !== "\r" && ch !== "\n") continue;
      fragments.push(text.slice(start, i));
      const complete = fragments.join("");
      fragments = [];
      await line(complete);
      if (ch === "\r") {
        if (text[i + 1] === "\n") i++;
        else if (i === text.length - 1) skipLF = true;
      }
      start = i + 1;
    }
    if (start < text.length) fragments.push(text.slice(start));
  }
  try {
    while (true) {
      const received = await reader.read();
      if (received.done) break;
      bytes();
      await chunk(decoder.decode(received.value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
