// SPDX-License-Identifier: LGPL-3.0-only
import type {
  IndexEntry,
  Message,
  ModelCatalog,
  ReportedTokens,
  UsageSummary,
} from "@otk/protocol";
import { usageCost } from "./usage.ts";
export function reportedTokens(
  tokens: ReportedTokens | undefined,
): number | undefined {
  if (!tokens) return;
  const values = [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache.read,
    tokens.cache.write,
  ];
  if (values.some((value) => value === null)) return;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}
export function sessionSummary(
  entry: IndexEntry | undefined,
  message?: Message,
): UsageSummary | undefined {
  return message
    ? message.role === "assistant"
      ? entry?.digest.turns[message.replyTo ?? message.id]
      : undefined
    : entry?.digest.total;
}
export function summaryMeter(
  entry: IndexEntry | undefined,
  catalog?: ModelCatalog,
): { tokens?: number; limit?: number; fraction?: number } {
  if (entry?.digest.state !== "ready") return {};
  const last = entry?.digest.last, tokens = reportedTokens(last?.context);
  const limit = last?.model &&
    catalog?.providers.find((p) => p.id === last.model!.provider)?.models.find((
      m,
    ) => m.id === last.model!.model)?.contextLimit;
  return {
    tokens,
    ...(tokens !== undefined && limit !== undefined && limit > 0
      ? { limit, fraction: Math.min(1, tokens / limit) }
      : {}),
  };
}
export function digestLabel(entry: IndexEntry | undefined): string {
  return entry?.digest.state === "ready"
    ? "Usage unavailable"
    : entry?.digest.state === "unavailable"
    ? "Usage unavailable"
    : "Digesting…";
}
export function digestProgress(
  entries: readonly IndexEntry[],
): { busy: boolean; announcement: string } {
  const busy = entries.some((entry) => entry.digest.state === "digesting");
  return {
    busy,
    announcement: entries.length && !busy ? "Session summaries updated." : "",
  };
}
export function deletedFacts(
  entry: IndexEntry,
  showCost: boolean,
  date: (time: number) => string,
): { label: string; value: string; description?: string }[] {
  const total = entry.digest.total;
  return [
    { label: "Project", value: entry.directory },
    { label: "Created", value: date(entry.timeCreated) },
    { label: "Last activity", value: date(entry.timeUpdated) },
    {
      label: "Messages",
      value: entry.digest.messageCount?.toLocaleString("en-US") ??
        "Not yet digested",
    },
    ...(entry.digest.last?.agent
      ? [{ label: "Last agent", value: entry.digest.last.agent }]
      : []),
    ...(entry.digest.last?.model
      ? [{
        label: "Last model",
        value:
          `${entry.digest.last.model.provider}/${entry.digest.last.model.model}`,
      }]
      : []),
    ...(total
      ? [
        { label: "Model calls", value: String(total.calls) },
        ...Object.entries({
          "New input": total.tokens.input,
          Output: total.tokens.output,
          Reasoning: total.tokens.reasoning,
          "Cache read": total.tokens.cache.read,
          "Cache write": total.tokens.cache.write,
        }).map(([label, value]) => ({
          label,
          value: value === null ? "Unavailable" : value.toLocaleString("en-US"),
        })),
      ]
      : [{ label: "Reported usage", value: "Unavailable" }]),
    ...(showCost
      ? [{
        label: "Reported cost",
        value: total?.cost == null ? "Unavailable" : usageCost(total.cost),
        description: total?.cost == null
          ? undefined
          : `Exact cost: ${usageCost(total.cost, "exact")}`,
      }]
      : []),
    { label: "Session ID", value: entry.id },
  ];
}
