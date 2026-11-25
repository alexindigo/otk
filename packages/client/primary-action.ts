// SPDX-License-Identifier: LGPL-3.0-only
export interface PrimaryActionState<M = unknown> {
  readonly mode?: M;
  readonly label: string;
  readonly visible: true;
  readonly available: boolean;
  readonly pending: boolean;
  readonly reason?: string;
}
export interface PrimaryAction<T = void, M = unknown> {
  readonly state: PrimaryActionState<M>;
  subscribe(listener: () => void): () => void;
  /** Recheck live readiness after asynchronous preparation, during this intent. */
  permitted(): boolean;
  invoke(input: T): Promise<void>;
}
/** One availability and admission boundary, independent of DOM or framework.
 * The caller retains its existing captured submission/request lifetime. */
export function createPrimaryAction<T = void, M = undefined>(options: {
  label(): string;
  mode?(): M;
  unavailable(): string | undefined;
  pending?(): boolean;
  pendingReason: string | ((mode: M | undefined) => string);
  run(input: T, mode: M | undefined): void | Promise<void>;
}): PrimaryAction<T, M> {
  const running = new Set<M | undefined>();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const owner: PrimaryAction<T, M> = {
    get state(): PrimaryActionState<M> {
      const mode = options.mode?.();
      const pending = running.has(mode) || !!options.pending?.();
      const reason = pending
        ? typeof options.pendingReason === "function"
          ? options.pendingReason(mode)
          : options.pendingReason
        : options.unavailable();
      return {
        ...(mode === undefined ? {} : { mode }),
        label: options.label(),
        visible: true,
        available: reason === undefined,
        pending,
        reason,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    permitted: () => options.unavailable() === undefined,
    async invoke(input) {
      const state = owner.state;
      if (!state.available) return;
      running.add(state.mode);
      publish();
      try {
        const result = options.run(input, state.mode);
        if (result) await result;
      } finally {
        running.delete(state.mode);
        publish();
      }
    },
  };
  return owner;
}

export type ComposerMode = "send" | "stop";
export interface SessionActivity {
  unstarted: number;
  running: boolean;
  stopping?: boolean;
}
export function canStop(activity: SessionActivity): boolean {
  return activity.unstarted > 0 || activity.running;
}
export function composerMode(
  facts: SessionActivity & { blank: boolean },
): ComposerMode {
  return facts.blank && (canStop(facts) || facts.stopping) ? "stop" : "send";
}
export function composerLabel(mode: ComposerMode): string {
  return mode === "stop" ? "Stop" : "Send";
}
export function stopUnavailable(
  facts: {
    active: boolean;
    suspended: boolean;
    connected: boolean;
    supported: boolean;
  },
): string | undefined {
  if (!facts.active) return "Composer is no longer active";
  if (facts.suspended) return "Answer the pending request first";
  if (!facts.connected) return "Reconnect to stop";
  if (!facts.supported) return "Stopping is not supported here";
}

/** Draft facts, not element existence, determine ordinary Send readiness. */
export function promptUnavailable(input: {
  active: boolean;
  suspended: boolean;
  connected: boolean;
  supported: boolean;
  content: boolean;
  chips: readonly { pending?: boolean; error?: unknown }[];
}): string | undefined {
  if (!input.active) return "Composer is no longer active";
  if (input.suspended) return "Answer the pending request first";
  if (!input.connected) return "Reconnect to send";
  if (!input.supported) return "Sending is not supported here";
  if (input.chips.some((chip) => chip.error)) {
    return "Remove or retry the failed attachment";
  }
  if (input.chips.some((chip) => chip.pending)) return "Waiting for attachment";
  if (!input.content) return "Write a message";
}
