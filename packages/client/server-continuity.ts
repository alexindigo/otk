// SPDX-License-Identifier: LGPL-3.0-only
export const UNREACHABLE_GRACE_MS = 10_000;

export interface ServerIdentity {
  build?: string;
  instance?: string;
}
export type ServerContinuity =
  | { kind: "away" | "unreachable"; since: number; refused?: string }
  | { kind: "live"; restarted?: { instance: string; updated: boolean } }
  | { kind: "updated"; build?: string; protocol?: number; refused?: string };

export interface ContinuityMemory {
  /** Present only for the connection that served this page. */
  page?: { build?: string };
  baseline?: ServerIdentity;
  current?: ServerIdentity;
}

export function lost(state: ServerContinuity, now: number): ServerContinuity {
  return state.kind === "live" ? { kind: "away", since: now } : state;
}

export function graceElapsed(state: ServerContinuity): ServerContinuity {
  return state.kind === "away" ? { ...state, kind: "unreachable" } : state;
}

export function reached(state: ServerContinuity): ServerContinuity {
  return state.kind === "away" || state.kind === "unreachable"
    ? { kind: "live" }
    : state;
}

export function welcomed(
  state: ServerContinuity,
  memory: ContinuityMemory,
  seen: ServerIdentity,
): { state: ServerContinuity; memory: ContinuityMemory } {
  const next = { ...memory, current: seen };
  if (state.kind === "updated") return { state, memory: next };
  const expected = memory.page?.build ?? memory.baseline?.build;
  if (memory.page && expected && seen.build && seen.build !== expected) {
    return { state: outdated(state, { build: seen.build }), memory: next };
  }
  if (!memory.baseline) {
    return { state: { kind: "live" }, memory: { ...next, baseline: seen } };
  }
  const updated = !memory.page && seen.build !== memory.baseline.build;
  if (updated) next.baseline = seen;
  const restarted =
    seen.instance && (updated || seen.instance !== memory.current?.instance)
      ? { instance: seen.instance, updated }
      : undefined;
  return {
    state: restarted ? { kind: "live", restarted } : { kind: "live" },
    memory: next,
  };
}

export function outdated(
  state: ServerContinuity,
  facts: { build?: string; protocol?: number },
): ServerContinuity {
  return state.kind === "updated" ? state : { kind: "updated", ...facts };
}

export function refused(
  state: ServerContinuity,
  reason?: string,
): ServerContinuity {
  return state.kind === "live" || state.refused === reason
    ? state
    : { ...state, refused: reason };
}

/** The actionable problem shown by both server presentations. */
export function serverProblem(
  state: ServerContinuity | undefined,
  label: string,
): { title: string; body: string; refusal?: string; key: string } | undefined {
  if (state?.kind === "updated") {
    return {
      title: `${label} was updated`,
      body: "Drafts are kept",
      refusal: state.refused,
      key: `updated:${state.build ?? `protocol-${state.protocol}`}`,
    };
  }
  if (
    state?.kind === "unreachable" || (state?.kind === "away" && state.refused)
  ) {
    return {
      title: `Can't reach ${label}`,
      body: "Retrying. Drafts are kept.",
      refusal: state.refused,
      key: `unreachable:${state.since}`,
    };
  }
}

export const SERVER_RELOAD = "server.reload";
export const SERVER_RELOAD_LABEL = "Reload";
