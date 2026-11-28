// SPDX-License-Identifier: LGPL-3.0-only
import type {
  BlockedCause,
  HelperDisposition,
  RunningShells,
} from "./entity-state.ts";
import type { ProjectStatus } from "./inbox.ts";
import type {
  SessionSettlement,
  Supervision,
  TerminalOutcome,
} from "./supervision.ts";

export interface SessionTransitionFacts {
  deleted: boolean;
  archived: boolean;
  fresh: boolean;
  helper: boolean;
  opened: boolean;
  questions: number;
  permissions: number;
  work: boolean;
  operation?: "working" | "blocked";
  terminal: number;
  outcome?: TerminalOutcome;
  unseen: boolean;
  confirmed?: number;
}

export interface InputPhase {
  state: "pending" | "settled-locally" | "settled-remotely" | "retired";
  dismissed: boolean;
}

export type InputEvent =
  | { type: "observe" | "dismiss" | "show" }
  | { type: "settle"; state: Exclude<InputPhase["state"], "pending"> };

/** The request owner supplies identity and accepted authority. A terminal
 * identity cannot be reopened by a late compatibility or inventory row. */
export function inputTransition(
  current: InputPhase | undefined,
  event: InputEvent,
): {
  rule: string;
  phase?: InputPhase;
} {
  if (current && current.state !== "pending") {
    return { rule: "input.terminal-replay" };
  }
  switch (event.type) {
    case "observe":
      return current ? { rule: "input.refresh", phase: current } : {
        rule: "input.admit",
        phase: { state: "pending", dismissed: false },
      };
    case "settle":
      return {
        rule: `input.${event.state}`,
        phase: { state: event.state, dismissed: current?.dismissed ?? false },
      };
    default: {
      const dismissed = event.type === "dismiss";
      return !current || current.dismissed === dismissed
        ? { rule: "input.presentation-replay" }
        : { rule: `input.${event.type}`, phase: { ...current, dismissed } };
    }
  }
}

/** Shell inventory is already fenced by the native owner. Count only its
 * live rows; a terminal, pending result, or unknown read is not a shell. */
export function shellTransition(items: RunningShells["items"]): RunningShells {
  return {
    state: items.length ? "working" : "none",
    count: items.length,
    items,
  };
}

export type ProjectSelectionPhase = "loading" | "empty" | "unavailable";
export type ProjectSelectionEvent =
  | { type: "lookup" | "route-away" }
  | { type: "rejected" | "resolved"; current: boolean; sessionID?: string };

/** The route owner resolves identity/connection before delivering an event. */
export function projectSelectionTransition(
  current: ProjectSelectionPhase | undefined,
  event: ProjectSelectionEvent,
): ProjectSelectionPhase | undefined {
  switch (event.type) {
    case "lookup":
      return "loading";
    case "route-away":
      return;
    case "rejected":
      return event.current ? "unavailable" : current;
    case "resolved":
      return !event.current ? current : event.sessionID ? undefined : "empty";
  }
}

type SessionVerdict = {
  status: ProjectStatus;
  state: Supervision["state"];
  cause?: BlockedCause;
  helper?: HelperDisposition;
};
type SessionRule = readonly [
  id: string,
  accepts: (f: SessionTransitionFacts) => boolean,
  result: (f: SessionTransitionFacts) => SessionVerdict,
];
const need = (cause: BlockedCause): SessionVerdict => ({
  status: "blocked",
  state: "needsYou",
  cause,
  helper: "needsYou",
});
const working: SessionVerdict = {
  status: "working",
  state: "working",
  helper: "running",
};

/** Ordered D35/D72/D76/D81 rules. Input facts are already owner-scoped and
 * freshness-qualified. In particular settlement uncertainty is never work. */
const sessionRules = [
  [
    "session.retired",
    (f) => f.deleted,
    () => ({ status: "none", state: "none" }),
  ],
  ["session.question", (f) => f.questions > 0, () => need("question")],
  [
    "session.operation-blocked",
    (f) => f.operation === "blocked",
    () => need("operation"),
  ],
  [
    "session.unseen-failure",
    (f) => f.unseen && f.outcome === "failed",
    (f) => need(f.helper ? "failedHelper" : "failure"),
  ],
  ["session.permission", (f) => f.permissions > 0, () => need("permission")],
  ["session.work", (f) => f.work || f.operation === "working", () => working],
  [
    "session.unseen-finish",
    (f) => f.unseen,
    () => ({ status: "finished", state: "finishedUnseen", helper: "finished" }),
  ],
  [
    "session.retained-open",
    (f) => f.helper && f.opened,
    () => ({ status: "none", state: "none", helper: "opened" }),
  ],
  [
    "session.no-evidence",
    () => true,
    () => ({ status: "none", state: "none" }),
  ],
] as const satisfies readonly SessionRule[];

export function sessionTransition(
  facts: SessionTransitionFacts,
): SessionVerdict & {
  rule: string;
  unseen: boolean;
  settlement?: SessionSettlement;
} {
  const [rule, , pick] = sessionRules.find(([, accepts]) => accepts(facts))!;
  const verdict = pick(facts);
  const {
    fresh,
    deleted,
    archived,
    operation,
    work,
    terminal,
    unseen,
    outcome,
    confirmed,
  } = facts;
  const settled = fresh && !deleted && !archived && !operation && !work &&
    facts.permissions === 0 && facts.questions === 0 && terminal > 0 &&
    confirmed === terminal && outcome;
  return {
    ...verdict,
    rule,
    unseen: !deleted && unseen,
    ...(!facts.helper ? { helper: undefined } : {}),
    ...(settled
      ? { settlement: { id: terminal, live: true, unseen, outcome: settled } }
      : {}),
  };
}
