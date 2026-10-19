// SPDX-License-Identifier: LGPL-3.0-only
import type { Message, ModelCatalog } from "@otk/protocol";

/** Latest reported context footprint, not the sum of repeated prompt inputs.
 * Cost is explicitly limited to loaded messages when history is paged. The
 * denominator belongs to the same reported model, never the next prompt. */
export function contextMeter(
  messages: readonly Message[],
  catalog?: ModelCatalog,
): {
  tokens?: number;
  cost?: number;
  limit?: number;
  fraction?: number;
} {
  const replies = messages.filter((m) => m.role === "assistant");
  const latest = replies.findLast((m) =>
    m.tokens.input + m.tokens.output + m.tokens.reasoning +
        m.tokens.cache.read + m.tokens.cache.write > 0
  );
  const tokens = latest && latest.tokens.input + latest.tokens.output +
      latest.tokens.reasoning + latest.tokens.cache.read +
      latest.tokens.cache.write;
  const limit = latest &&
    catalog?.providers.find((p) => p.id === latest.model.provider)
      ?.models.find((m) => m.id === latest.model.model)?.contextLimit;
  return {
    ...(latest
      ? {
        tokens,
      }
      : {}),
    ...(tokens !== undefined && limit !== undefined && Number.isFinite(limit) &&
        limit > 0
      ? { limit, fraction: Math.min(1, Math.max(0, tokens / limit)) }
      : {}),
    ...(replies.length
      ? { cost: replies.reduce((sum, m) => sum + m.cost, 0) }
      : {}),
  };
}
