// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef, ToolCall, TurnTiming } from "@otk/protocol";
import { TurnTimingAccumulator } from "@otk/protocol";
import type { InboxStatus } from "./inbox.ts";

export interface EntityIdentity {
  sessionID?: string;
  turnID?: string;
  timing?: TurnTiming;
  model?: ModelRef;
  tool?: ToolCall;
}
export type EntityFact = {
  final: boolean;
  active: boolean;
} & ({ known: true; value: number } | { known: false; value?: never });
export interface EntityFacts {
  session: { id?: string; title?: string; status?: InboxStatus };
  model?: ModelRef;
  reply?: {
    id: string;
    working: EntityFact;
    completed: EntityFact;
    explanation?: string;
  };
  tool?: { id: string; working: EntityFact; completed: EntityFact };
}
export interface EntityFactSources {
  session(id: string): { title?: string; status?: InboxStatus };
}
/** Scope is explicit. Missing turn/tool evidence cannot borrow a session clock. */
export function entityFacts(
  identity: EntityIdentity,
  sources?: EntityFactSources,
): EntityFacts {
  const fact = (
    value: number | undefined,
    final = false,
    active = false,
  ): EntityFact =>
    value === undefined
      ? { known: false, final, active }
      : { known: true, value, final, active };
  const timing = identity.timing;
  const final = timing?.state === "known" ||
    timing?.state === "unknown" && timing.terminal;
  const active = timing?.state === "active";
  const tool = identity.tool;
  const toolFinal = !!tool &&
    (tool.status === "completed" || tool.status === "error" ||
      tool.status === "denied");
  return {
    session: {
      id: identity.sessionID,
      ...(identity.sessionID ? sources?.session(identity.sessionID) : {}),
    },
    model: identity.model,
    ...(identity.turnID
      ? {
        reply: {
          id: identity.turnID,
          working: fact(
            timing && timing.state !== "unknown" ? timing.workingMs : undefined,
            final,
            active,
          ),
          completed: fact(
            final && timing && "end" in timing ? timing.end : undefined,
            final,
            active,
          ),
          explanation: timing?.state === "unknown"
            ? timing.explanation
            : undefined,
        },
      }
      : {}),
    ...(tool
      ? {
        tool: {
          id: tool.callID,
          working: fact(
            toolFinal ? TurnTimingAccumulator.segment([tool.time]) : undefined,
            toolFinal,
            tool.status === "running",
          ),
          completed: fact(
            toolFinal ? tool.time.end : undefined,
            toolFinal,
            tool.status === "running",
          ),
        },
      }
      : {}),
  };
}
