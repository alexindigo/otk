// SPDX-License-Identifier: LGPL-3.0-only
export interface PrimaryActionState {
  readonly label: string;
  readonly visible: true;
  readonly available: boolean;
  readonly pending: boolean;
  readonly reason?: string;
}
export interface PrimaryAction<T = void> {
  readonly state: PrimaryActionState;
  subscribe(listener: () => void): () => void;
  /** Recheck live readiness after asynchronous preparation, during this intent. */
  permitted(): boolean;
  invoke(input: T): Promise<void>;
}
/** One availability and admission boundary, independent of DOM or framework.
 * The caller retains its existing captured submission/request lifetime. */
export function createPrimaryAction<T = void>(options: {
  label(): string;
  unavailable(): string | undefined;
  pending?(): boolean;
  pendingReason: string;
  run(input: T): void | Promise<void>;
}): PrimaryAction<T> {
  let running = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const owner: PrimaryAction<T> = {
    get state(): PrimaryActionState {
      const pending = running || !!options.pending?.();
      const reason = pending ? options.pendingReason : options.unavailable();
      return {
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
      if (!owner.state.available) return;
      running = true;
      publish();
      try {
        const result = options.run(input);
        if (result) await result;
      } finally {
        running = false;
        publish();
      }
    },
  };
  return owner;
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
