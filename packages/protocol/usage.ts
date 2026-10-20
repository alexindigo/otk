// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, ModelRef, Part, Tokens } from "./content.ts";

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
  tokens: Tokens;
  cost: number;
  completed: boolean;
  time?: UsageTime;
  tools?: UsageTool[];
}
export interface ModelUsage {
  model: ModelRef;
  tokens: Tokens;
  cost: number;
}
export interface UsageTotal {
  tokens: Tokens;
  cost: number;
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
  "usage.get": { params: { sessionID: string }; result: SessionUsage };
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
function empty(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}
function add(target: Tokens, source: Tokens): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cache.read += source.cache.read;
  target.cache.write += source.cache.write;
}
/** Sole aggregation owner, shared by producers and live consumers; never stores parts. */
export class UsageLedger {
  #messages = new Map<string, UsageMessage>();
  constructor(
    readonly sessionID: string,
    messages: readonly UsageMessage[] = [],
  ) {
    for (const message of messages) this.upsert(message);
  }
  upsert(message: UsageMessage): void {
    const previous = this.#messages.get(message.id);
    if (previous?.completed && !message.completed) return;
    this.#messages.set(message.id, {
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
    });
  }
  remove(id: string): void {
    this.#messages.delete(id);
  }
  tool(messageID: string, tool: UsageTool): void {
    const message = this.#messages.get(messageID);
    if (!message) return;
    const tools = new Map(message.tools?.map((item) => [item.id, item]));
    tools.set(tool.id, { ...tool });
    message.tools = [...tools.values()].sort((a, b) =>
      a.id.localeCompare(b.id)
    );
  }
  removeTool(messageID: string, id: string): void {
    const message = this.#messages.get(messageID);
    if (message) {
      message.tools = message.tools?.filter((tool) => tool.id !== id);
    }
  }
  snapshot(): SessionUsage {
    const summarize = (messages: Iterable<UsageMessage>): UsageTotal => {
      const tokens = empty(), models = new Map<string, ModelUsage>();
      let cost = 0, count = 0, start = Infinity, end = -Infinity;
      let known = true, finished = true;
      for (const message of messages) {
        count++;
        if (!message.time) known = false;
        else {
          start = Math.min(start, message.time.start);
          if (!message.completed || message.time.end === undefined) {
            finished = false;
          } else end = Math.max(end, message.time.end);
        }
        add(tokens, message.tokens);
        cost += message.cost;
        const key = JSON.stringify([
          message.model.provider,
          message.model.model,
        ]);
        let model = models.get(key);
        if (!model) {
          models.set(
            key,
            model = { model: message.model, tokens: empty(), cost: 0 },
          );
        }
        add(model.tokens, message.tokens);
        model.cost += message.cost;
      }
      return {
        tokens,
        cost,
        ...(count && known
          ? { time: { start, end: finished ? end : undefined } }
          : {}),
        models: [...models.values()].sort((a, b) =>
          JSON.stringify(a.model).localeCompare(JSON.stringify(b.model))
        ),
      };
    };
    const turns = new Map<string, UsageMessage[]>();
    for (const message of this.#messages.values()) {
      const turn = turns.get(message.turnID) ?? [];
      turn.push(message);
      turns.set(message.turnID, turn);
    }
    return {
      sessionID: this.sessionID,
      total: summarize(this.#messages.values()),
      turns: Object.fromEntries(
        [...turns].sort(([a], [b]) => a.localeCompare(b)).map((
          [id, messages],
        ) => [id, summarize(messages)]),
      ),
      messages: [...this.#messages.values()].sort((a, b) =>
        (a.time?.start ?? 0) - (b.time?.start ?? 0) || a.id.localeCompare(b.id)
      ).map((message) => structuredClone(message)),
    };
  }
}
