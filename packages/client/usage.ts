// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Message,
  ModelCatalog,
  SessionUsage,
  Tokens,
  UsageTime,
  UsageTotal,
} from "@otk/protocol";

export interface UsageCategory {
  label: string;
  tokens: number;
  /** Catalog-priced USD; omitted when a contributing model's price is unknown. */
  cost?: number;
}
export interface PricedUsage {
  tokens: number;
  /** The backend's reported cost, never replaced by catalog estimates. */
  cost: number;
  categories: UsageCategory[];
}
export interface CallUsage extends PricedUsage {
  id: string;
  activity: string;
  time?: UsageTime;
}
export interface TurnUsage extends PricedUsage {
  calls: CallUsage[];
  time?: UsageTime;
}

/** Select an authoritative turn by identity, never by transcript-page contents. */
export function turnUsage(
  snapshot: SessionUsage | undefined,
  message: Message,
  catalog?: ModelCatalog,
): TurnUsage | undefined {
  if (
    !snapshot || message.role !== "assistant" ||
    snapshot.sessionID !== message.sessionID
  ) return;
  const key = message.replyTo ?? message.id;
  if (!Object.hasOwn(snapshot.turns, key)) return;
  const total = snapshot.turns[key];
  return {
    ...priceUsage(total, catalog),
    time: total.time,
    calls: snapshot.messages.filter((call) => call.turnID === key).map((
      call,
    ) => ({
      ...priceUsage(
        { tokens: call.tokens, cost: call.cost, models: [call] },
        catalog,
      ),
      id: call.id,
      activity: call.tools?.length
        ? call.tools.map((tool) =>
          tool.summary ? `${tool.name}: ${tool.summary}` : tool.name
        ).join(", ")
        : "answered",
      time: call.time,
    })),
  };
}

/** Price authoritative per-model summaries. Never aggregate transcript content. */
export function priceUsage(
  total: UsageTotal,
  catalog?: ModelCatalog,
): PricedUsage {
  const categories: UsageCategory[] = [
    "Input",
    "Output",
    "Reasoning",
    "Cache read",
    "Cache write",
  ]
    .map((label) => ({ label, tokens: 0, cost: 0 }));
  const counts = (
    tokens: Tokens,
  ) => [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache.read,
    tokens.cache.write,
  ];
  categories.forEach((category, i) =>
    category.tokens = counts(total.tokens)[i]
  );
  for (const step of total.models) {
    const prices = catalog?.providers.find((p) => p.id === step.model.provider)
      ?.models.find((m) => m.id === step.model.model)?.cost;
    const tokens = counts(step.tokens);
    const rates = [
      prices?.input,
      prices?.output,
      prices?.output,
      prices?.cache.read,
      prices?.cache.write,
    ];
    for (const [index, category] of categories.entries()) {
      const rate = rates[index];
      if (rate === undefined || !Number.isFinite(rate) || rate < 0) {
        delete category.cost;
      } else if (category.cost !== undefined) {
        category.cost += tokens[index] * rate / 1_000_000;
      }
    }
  }
  return {
    tokens: categories.reduce((sum, c) => sum + c.tokens, 0),
    cost: total.cost,
    categories,
  };
}

/** Compact visible total, with exact counts retained in the detail rows. */
export function usageTokens(tokens: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(tokens);
}
/** Keep small nonzero charges visible without adding noise to ordinary totals. */
export function usageCost(cost: number): string {
  if (cost > 0 && cost < .000001) return "<$0.000001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: cost !== 0 && Math.abs(cost) < .01 ? 6 : 2,
  }).format(cost);
}
