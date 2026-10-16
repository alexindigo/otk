// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "@otk/protocol";

/** Latest reported context footprint, not the sum of repeated prompt inputs.
 * Cost is explicitly limited to loaded messages when history is paged. No model
 * window is present in the wire contract, so consumers must not invent a %. */
export function contextMeter(messages: readonly Message[]): {
  tokens?: number;
  cost?: number;
} {
  const replies = messages.filter((m) => m.role === "assistant");
  const latest = replies.findLast((m) =>
    m.tokens.input + m.tokens.output + m.tokens.reasoning +
        m.tokens.cache.read + m.tokens.cache.write > 0
  );
  return {
    ...(latest
      ? {
        tokens: latest.tokens.input + latest.tokens.output +
          latest.tokens.reasoning +
          latest.tokens.cache.read + latest.tokens.cache.write,
      }
      : {}),
    ...(replies.length
      ? { cost: replies.reduce((sum, m) => sum + m.cost, 0) }
      : {}),
  };
}
