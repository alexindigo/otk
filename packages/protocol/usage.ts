// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";
export const usageRequestMetadata: Readonly<Record<string, RequestMetadata>> = {
  "usage.get": { kind: "read", pending: "Loading usage" },
};
import type { AssistantMessage, ModelRef, Part } from "./content.ts";
import type { ReportedTokens, UsageSummary } from "./digest.ts";
import type { ContentClock, TranscriptVersion } from "./transcript.ts";

/** Existing tool labels only, never inputs, output or transcript parts. */
export interface UsageTool {
  id: string;
  name: string;
  summary?: string;
}
export interface UsageTime {
  start: number;
  end?: number;
}

/** Usage headers only. Exact baselines make snapshot/live replacement idempotent. */
export interface UsageMessage {
  id: string;
  turnID: string;
  model: ModelRef;
  tokens: ReportedTokens;
  cost: number | null;
  completed: boolean;
  time?: UsageTime;
  tools?: UsageTool[];
}
export interface ModelUsage {
  model: ModelRef;
  tokens: ReportedTokens;
  cost: number | null;
}
export interface UsageTotal {
  tokens: ReportedTokens;
  cost: number | null;
  models: ModelUsage[];
  time?: UsageTime;
}
export interface SessionUsage {
  sessionID: string;
  total: UsageTotal;
  turns: Record<string, UsageTotal>;
  messages: UsageMessage[];
}
export interface UsageRpcMethods {
  "usage.get": {
    params: { sessionID: string; turnID: string };
    result: TurnUsageDetail;
  };
}
export type UsageCallDetail = UsageMessage;
export interface TurnUsageSnapshot {
  sessionID: string;
  turnID: string;
  revision: number;
  summary: UsageSummary;
  calls: UsageCallDetail[];
}
export interface TurnUsageDetail extends TurnUsageSnapshot {
  clock: ContentClock;
  version: TranscriptVersion;
}
export interface UsageChange {
  calls: { upsert: UsageCallDetail[]; remove: string[] };
  turns: string[];
}
export function usageHeader(message: AssistantMessage): UsageMessage {
  return {
    id: message.id,
    turnID: message.replyTo ?? message.id,
    model: message.model,
    tokens: message.tokens,
    cost: message.cost,
    completed: message.time.completed !== undefined,
    time: { start: message.time.created, end: message.time.completed },
    ...(message.parts.length
      ? {
        tools: message.parts.flatMap((part) => {
          const tool = usageTool(part);
          return tool ? [tool] : [];
        }),
      }
      : {}),
  };
}
/** Project the same title/summary already supplied to tool presentation. */
export function usageTool(part: Part): UsageTool | undefined {
  if (part.kind !== "tool") return;
  return {
    id: part.id,
    name: part.call.sourceName ??
      (part.call.tool === "external" ? part.call.name : part.call.tool),
    summary: part.call.title,
  };
}
const values = (
  message: UsageMessage,
) => [
  message.tokens.input,
  message.tokens.output,
  message.tokens.reasoning,
  message.tokens.cache.read,
  message.tokens.cache.write,
  message.cost,
];
const tokensFrom = (v: (number | null)[]): ReportedTokens => ({
  input: v[0],
  output: v[1],
  reasoning: v[2],
  cache: { read: v[3], write: v[4] },
});
/** Counted ordered scalar extrema; replacements never scan call baselines. */
class Extrema {
  values: number[] = [];
  counts = new Map<number, number>();
  change(value: number, direction: number) {
    const count = (this.counts.get(value) ?? 0) + direction;
    if (count === 0) {
      this.counts.delete(value);
      this.values.splice(this.at(value), 1);
    } else {
      if (!this.counts.has(value)) this.values.splice(this.at(value), 0, value);
      this.counts.set(value, count);
    }
  }
  at(value: number) {
    let low = 0, high = this.values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.values[mid] < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
class Aggregate {
  count = 0;
  sums = Array<number>(6).fill(0);
  unknown = Array<number>(6).fill(0);
  starts = new Extrema();
  ends = new Extrema();
  contexts = new Extrema();
  untimed = 0;
  unfinished = 0;
  unknownContext = 0;
  change(message: UsageMessage, direction: number) {
    this.count += direction;
    values(message).forEach((value, i) => {
      if (value === null) this.unknown[i] += direction;
      else this.sums[i] += direction * value;
    });
    if (!message.time) this.untimed += direction;
    else {
      this.starts.change(message.time.start, direction);
      if (!message.completed || message.time.end === undefined) {
        this.unfinished += direction;
      } else this.ends.change(message.time.end, direction);
    }
    const { input, cache } = message.tokens;
    if (input === null || cache.read === null || cache.write === null) {
      this.unknownContext += direction;
    } else this.contexts.change(input + cache.read + cache.write, direction);
  }
  read(): UsageSummary {
    const v = this.sums.map((sum, i) => this.unknown[i] ? null : sum);
    return {
      calls: this.count,
      tokens: tokensFrom(v),
      cost: v[5],
      contextPeak: this.unknownContext
        ? null
        : this.contexts.values.at(-1) ?? 0,
      ...(this.count && !this.untimed
        ? {
          time: {
            start: this.starts.values[0],
            end: this.unfinished ? undefined : this.ends.values.at(-1),
          },
        }
        : {}),
    };
  }
}
/** Sole aggregation owner, shared by producers and live consumers; never stores parts. */
export class UsageLedger {
  #messages = new Map<string, UsageMessage>();
  #total = new Aggregate();
  #turns = new Map<string, Aggregate>();
  #models = new Map<string, { model: ModelRef; aggregate: Aggregate }>();
  #turnModels = new Map<
    string,
    Map<string, { model: ModelRef; aggregate: Aggregate }>
  >();
  constructor(
    readonly sessionID: string,
    messages: readonly UsageMessage[] = [],
  ) {
    for (const message of messages) this.upsert(message);
  }
  upsert(message: UsageMessage): UsageChange {
    const previous = this.#messages.get(message.id);
    if (previous?.completed && !message.completed) return this.#change();
    const nextValues = values(message);
    if (
      previous && previous.turnID === message.turnID &&
      previous.completed === message.completed &&
      previous.model.provider === message.model.provider &&
      previous.model.model === message.model.model &&
      values(previous).every((value, i) => value === nextValues[i]) &&
      (!message.time ||
        (previous.time?.start === message.time.start &&
          previous.time?.end === message.time.end)) &&
      (message.tools === undefined ||
        ((previous.tools?.length ?? 0) === message.tools.length &&
          message.tools.every((tool, i) => {
            const old = previous.tools![i];
            return old.id === tool.id && old.name === tool.name &&
              old.summary === tool.summary;
          })))
    ) return this.#change();
    const next = {
      id: message.id,
      turnID: message.turnID,
      model: { provider: message.model.provider, model: message.model.model },
      cost: message.cost,
      completed: message.completed,
      time: message.time ? { ...message.time } : previous?.time,
      tools: (message.tools ?? previous?.tools ?? []).map((tool) => ({
        ...tool,
      })),
      tokens: {
        input: message.tokens.input,
        output: message.tokens.output,
        reasoning: message.tokens.reasoning,
        cache: {
          read: message.tokens.cache.read,
          write: message.tokens.cache.write,
        },
      },
    };
    if (previous) this.#account(previous, -1);
    this.#messages.set(message.id, next);
    this.#account(next, 1);
    return this.#change([next], [], [
      ...new Set(
        [previous?.turnID, next.turnID].filter((id): id is string =>
          id !== undefined
        ),
      ),
    ]);
  }
  #change(
    upsert: UsageMessage[] = [],
    remove: string[] = [],
    turns: string[] = [],
  ): UsageChange {
    return { calls: { upsert, remove }, turns };
  }
  #account(message: UsageMessage, direction: number) {
    this.#total.change(message, direction);
    let turn = this.#turns.get(message.turnID);
    if (!turn) this.#turns.set(message.turnID, turn = new Aggregate());
    turn.change(message, direction);
    let models = this.#turnModels.get(message.turnID);
    if (!models) this.#turnModels.set(message.turnID, models = new Map());
    for (const map of [this.#models, models]) {
      const key = JSON.stringify(message.model);
      let model = map.get(key);
      if (!model) {
        map.set(
          key,
          model = { model: message.model, aggregate: new Aggregate() },
        );
      }
      model.aggregate.change(message, direction);
      if (!model.aggregate.count) map.delete(key);
    }
    if (!turn.count) {
      this.#turns.delete(message.turnID);
      this.#turnModels.delete(message.turnID);
    }
  }
  remove(id: string): UsageChange {
    const previous = this.#messages.get(id);
    if (!previous) return this.#change();
    this.#account(previous, -1);
    this.#messages.delete(id);
    return this.#change([], [id], [previous.turnID]);
  }
  tool(messageID: string, tool: UsageTool): UsageChange {
    const message = this.#messages.get(messageID);
    if (!message) return this.#change();
    const previous = message.tools?.find((value) => value.id === tool.id);
    if (
      previous && previous.name === tool.name &&
      previous.summary === tool.summary
    ) return this.#change();
    const tools = new Map(message.tools?.map((item) => [item.id, item]));
    tools.set(tool.id, { ...tool });
    const next = {
      ...message,
      tools: [...tools.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    this.#messages.set(messageID, next);
    return this.#change([next], [], [message.turnID]);
  }
  removeTool(messageID: string, id: string): UsageChange {
    const message = this.#messages.get(messageID);
    if (message?.tools?.some((tool) => tool.id === id)) {
      const next = {
        ...message,
        tools: message.tools?.filter((tool) => tool.id !== id),
      };
      this.#messages.set(messageID, next);
      return this.#change([next], [], [message.turnID]);
    }
    return this.#change();
  }
  call(id: string): UsageMessage | undefined {
    return this.#messages.get(id);
  }
  summary(turnID?: string): UsageSummary | undefined {
    return (turnID === undefined ? this.#total : this.#turns.get(turnID))
      ?.read();
  }
  turn(id: string): UsageTotal | undefined {
    const summary = this.summary(id);
    return summary &&
      {
        tokens: summary.tokens,
        cost: summary.cost,
        time: summary.time,
        models: this.#modelTotals(this.#turnModels.get(id)!),
      };
  }
  #modelTotals(
    models: Map<string, { model: ModelRef; aggregate: Aggregate }>,
  ): ModelUsage[] {
    return [...models].sort(([a], [b]) => a.localeCompare(b)).map(
      ([, item]) => {
        const summary = item.aggregate.read();
        return {
          model: item.model,
          tokens: summary.tokens,
          cost: summary.cost,
        };
      },
    );
  }
  detail(turnID: string, revision = 0): TurnUsageSnapshot {
    const summary = this.summary(turnID) ?? new Aggregate().read();
    return {
      sessionID: this.sessionID,
      turnID,
      revision,
      summary,
      calls: [...this.#messages.values()].filter((call) =>
        call.turnID === turnID
      ).sort((a, b) =>
        (a.time?.start ?? 0) - (b.time?.start ?? 0) || a.id.localeCompare(b.id)
      ).map((call) => structuredClone(call)),
    };
  }
  snapshot(): SessionUsage {
    const total = this.#total.read();
    return {
      sessionID: this.sessionID,
      total: {
        tokens: total.tokens,
        cost: total.cost,
        models: this.#modelTotals(this.#models),
        time: total.time,
      },
      turns: Object.fromEntries(
        [...this.#turns.keys()].sort().map((id) => [id, this.turn(id)!]),
      ),
      messages: [...this.#messages.values()].sort((a, b) =>
        (a.time?.start ?? 0) - (b.time?.start ?? 0) || a.id.localeCompare(b.id)
      ).map((message) => structuredClone(message)),
    };
  }
}
