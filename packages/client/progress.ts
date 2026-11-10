// SPDX-License-Identifier: LGPL-3.0-only
import type { ProgressFacts } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { humanDuration } from "./format.ts";

export interface ProgressDisplay {
  busy: boolean;
  text: string;
  rate?: number;
  eta?: [number, number];
}
const remaining = (seconds: number) =>
  humanDuration(Math.max(1, Math.ceil(seconds / 60)) * 60_000);
function waiting(reason: string | undefined, page: boolean): string {
  if (reason === "queued behind current work") {
    return page
      ? "waiting for another session to load"
      : "waiting for the open session to load first";
  }
  if (reason === "paused with no viewers") {
    return "paused while no window is open";
  }
  if (reason === "waiting for publication credit") {
    return "waiting for this window to catch up";
  }
  if (reason === "paused for memory capacity") {
    return "waiting for memory to become available";
  }
  if (reason === "waiting for the background work budget") {
    return "taking a short pause";
  }
  if (
    reason === "native unavailable" || reason === "waiting for native data" ||
    reason === "waiting for the newest page" ||
    reason === "waiting for an earlier page"
  ) {
    return page
      ? "waiting for opencode to respond"
      : "opencode isn't responding";
  }
  return "waiting for more information";
}

/** One estimator per scope generation; work time excludes readiness/I/O waits. */
export class ProgressEstimate {
  #last?: ProgressFacts;
  #rate?: number;
  #variance = 0;
  update(facts: ProgressFacts): void {
    const last = this.#last;
    if (
      !last || last.generation !== facts.generation ||
      facts.completed < last.completed
    ) {
      this.#rate = undefined;
      this.#variance = 0;
    } else {
      const ms = facts.activeMs - last.activeMs;
      const done = facts.completed - last.completed;
      if (ms > 0) {
        const sample = done * 1000 / ms;
        if (this.#rate === undefined && done > 0) this.#rate = sample;
        else if (this.#rate !== undefined) {
          const difference = sample - this.#rate;
          this.#rate += 0.3 * difference;
          this.#variance = 0.7 * (this.#variance + 0.3 * difference ** 2);
        }
      }
    }
    this.#last = { ...facts };
  }
  display(label: string, now: number): ProgressDisplay {
    const facts = this.#last;
    if (!facts) return { busy: false, text: "" };
    const busy = facts.phase !== "ready";
    if (!busy) return { busy: false, text: "" };
    const elapsedMs = Math.max(0, now - facts.started),
      elapsed = humanDuration(elapsedMs);
    const page = facts.phase === "reading" || facts.phase === "queued";
    const stalled = now - facts.advanced >= 45000;
    const count = facts.eligible === null
      ? `${facts.completed} found`
      : `${facts.completed} of ${facts.eligible}`;
    if (stalled) {
      return {
        busy,
        text: page
          ? `Still loading ${label.replace(/^Loading /, "")} (${elapsed}): ${
            waiting(
              facts.wait ?? (facts.phase === "queued"
                ? "queued behind current work"
                : undefined),
              true,
            )
          }`
          : `${label}: ${count}. No progress for ${
            humanDuration(now - facts.advanced)
          }, ${waiting(facts.wait, false)}`,
      };
    }
    const rate = this.#rate;
    let eta: [number, number] | undefined;
    if (!stalled && !facts.wait && rate && facts.eligible !== null) {
      const left = Math.max(0, facts.eligible - facts.completed);
      const spread = Math.sqrt(this.#variance);
      eta = spread / rate > 0.35
        ? [left / (rate + spread), left / Math.max(rate * 0.2, rate - spread)]
        : [left / rate, left / rate];
    }
    const estimate = eta
      ? eta[0] === eta[1]
        ? `, about ${remaining(eta[0])} left`
        : remaining(eta[0]) === remaining(eta[1])
        ? `, about ${remaining(eta[0])} left`
        : `, about ${remaining(eta[0])}-${remaining(eta[1])} left`
      : "";
    return {
      busy,
      text: page
        ? `${label}...${elapsedMs >= 10000 ? ` ${elapsed}` : ""}`
        : `${label}: ${count}${estimate}`,
      rate,
      eta,
    };
  }
}

/** Shared framework-free clock/publication owner, capped at one update per second. */
export interface ProgressOwner {
  subscribe(listener: () => void): () => void;
  reset(key: string): void;
  receive(key: string, facts: ProgressFacts): void;
  display(key: string, label: string): ProgressDisplay;
  stop(): void;
}
export function createProgress(
  factory: StateFactory = createState,
): ProgressOwner {
  const state = factory({ revision: 0 });
  const estimates = new Map<string, ProgressEstimate>();
  const active = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    state.update((draft) => {
      draft.revision++;
    });
    if (!active.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  return {
    subscribe: state.subscribe,
    reset(key: string) {
      estimates.delete(key);
      active.delete(key);
    },
    receive(key: string, facts: ProgressFacts) {
      let estimate = estimates.get(key);
      if (!estimate) estimates.set(key, estimate = new ProgressEstimate());
      estimate.update(facts);
      if (facts.phase === "ready") active.delete(key);
      else active.add(key);
      timer ??= setInterval(tick, 1000);
    },
    display(key: string, label: string): ProgressDisplay {
      state.state.revision;
      return estimates.get(key)?.display(label, Date.now()) ??
        { busy: false, text: "" };
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      estimates.clear();
      active.clear();
    },
  };
}
