// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Message,
  ModelCatalog,
  ReportedTokens,
  SessionUsage,
  TurnUsageDetail,
  UsageMessage,
  UsageTime,
  UsageTotal,
} from "@otk/protocol";

export interface UsageCategory {
  label: string;
  tokens: number | null;
  /** Catalog-priced USD; omitted when a contributing model's price is unknown. */
  cost: number | null;
}
export interface PricedUsage {
  tokens: number | null;
  /** Full prompt: uncached input plus cache read and cache write. */
  context: number | null;
  /** The backend's reported cost, never replaced by catalog estimates. */
  cost: number | null;
  categories: UsageCategory[];
}
export interface CallUsage extends PricedUsage {
  id: string;
  activity: string;
  time?: UsageTime;
}
export interface TurnUsage extends PricedUsage {
  calls: CallUsage[];
  /** Largest individual prompt, distinct from the sum of prompts or last call. */
  contextPeak: number | null;
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
  const calls = snapshot.messages.filter((call) => call.turnID === key).map((
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
  }));
  return {
    ...priceUsage(total, catalog),
    time: total.time,
    calls,
    contextPeak: calls.some((call) => call.context === null)
      ? null
      : Math.max(0, ...calls.map((call) => call.context!)),
  };
}

/** Price authoritative per-model summaries. Never aggregate transcript content. */
export function priceUsage(
  total: UsageTotal,
  catalog?: ModelCatalog,
): PricedUsage {
  const categories: UsageCategory[] = [
    "New input",
    "Output",
    "Reasoning",
    "Cache read",
    "Cache write",
  ]
    .map((label) => ({ label, tokens: 0, cost: 0 }));
  const counts = (
    tokens: ReportedTokens,
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
      if (
        rate === undefined || !Number.isFinite(rate) || rate < 0 ||
        tokens[index] === null
      ) {
        category.cost = null;
      } else if (category.cost !== null) {
        category.cost += tokens[index]! * rate / 1_000_000;
      }
    }
  }
  return {
    tokens: sumReported(categories.map((c) => c.tokens)),
    context: sumReported([
      total.tokens.input,
      total.tokens.cache.read,
      total.tokens.cache.write,
    ]),
    cost: total.cost,
    categories,
  };
}

/** Compact visible total, with exact counts retained in the detail rows. */
export function usageTokens(tokens: number | null): string {
  if (tokens === null) return "Not reported";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(tokens);
}
const costFormats = {
  display: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }),
  exact: new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 21,
  }),
};
/** One USD rule for every consumer; exact mode retains the reported value for AT. */
export function usageCost(
  cost: number | null,
  mode: "display" | "exact" = "display",
): string {
  if (cost === null) return "Not reported";
  const value = cost === 0 ? 0 : cost;
  if (mode === "display" && value !== 0 && Math.abs(value) < .01) {
    return value > 0 ? "<$0.01" : ">-$0.01";
  }
  return costFormats[mode].format(value);
}
function sumReported(values: (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}
/** Source-row identity cache. A live mutation prices only the replaced call. */
export function createTurnPricing(): (
  detail: TurnUsageDetail | undefined,
  catalog?: ModelCatalog,
) => TurnUsage | undefined {
  let catalog: ModelCatalog | undefined;
  let previous: TurnUsageDetail | undefined, priced: TurnUsage | undefined;
  const rows = new Map<string, { source: UsageMessage; value: CallUsage }>();
  return (
    detail: TurnUsageDetail | undefined,
    nextCatalog?: ModelCatalog,
  ): TurnUsage | undefined => {
    if (!detail) {
      rows.clear();
      previous = undefined;
      priced = undefined;
      return;
    }
    if (previous === detail && catalog === nextCatalog) return priced;
    if (catalog !== nextCatalog) {
      catalog = nextCatalog;
      rows.clear();
    }
    const ids = new Set(detail.calls.map((call) => call.id));
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
    const calls = detail.calls.map((source) => {
      const previous = rows.get(source.id);
      if (previous?.source === source) return previous.value;
      const value = {
        ...priceUsage({
          tokens: source.tokens,
          cost: source.cost,
          models: [source],
        }, catalog),
        id: source.id,
        activity: source.tools?.length
          ? source.tools.map((tool) =>
            tool.summary ? `${tool.name}: ${tool.summary}` : tool.name
          ).join(", ")
          : "answered",
        time: source.time,
      };
      rows.set(source.id, { source, value });
      return value;
    });
    const categories = [
      "New input",
      "Output",
      "Reasoning",
      "Cache read",
      "Cache write",
    ].map((label, i) => ({
      label,
      tokens: sumReported(calls.map((call) => call.categories[i].tokens)),
      cost: sumReported(calls.map((call) => call.categories[i].cost)),
    }));
    previous = detail;
    return priced = {
      calls,
      categories,
      tokens: sumReported(categories.map((c) => c.tokens)),
      context: sumReported([
        detail.summary.tokens.input,
        detail.summary.tokens.cache.read,
        detail.summary.tokens.cache.write,
      ]),
      cost: detail.summary.cost,
      contextPeak: detail.summary.contextPeak,
      time: detail.summary.time,
    };
  };
}
