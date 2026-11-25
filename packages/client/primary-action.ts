// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import { sendDiagnostic } from "./diagnostics.ts";
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

/** Draft facts, not element existence, determine ordinary Send readiness. */
export type ComposerSource = "enter" | "button" | "interrupt";
export interface ComposerFacts extends SessionActivity {
  active: boolean;
  suspended: boolean;
  connected: boolean;
  supported: boolean;
  stopSupported: boolean;
  content: boolean;
  chips: readonly { pending?: boolean; error?: unknown }[];
  sending: boolean;
  /** Explicit local commands are input, not a native submission. */
  local?: boolean;
}
export interface ComposerVerdict {
  kind: "send" | "stop" | "none";
  available: boolean;
  reason?: string;
}

/** The same live facts decide the affordance and every activation. */
export function composerAction(
  facts: ComposerFacts,
  source: ComposerSource,
): ComposerVerdict {
  const mode = composerMode({
    ...facts,
    blank: !facts.content && !facts.chips.length,
  });
  const verdict = (kind: ComposerVerdict["kind"], reason?: string) => ({
    kind,
    available: reason === undefined,
    reason,
  });
  const blocked = !facts.active
    ? "Composer is no longer active"
    : facts.suspended
    ? "Answer the pending request first"
    : undefined;
  if (source === "interrupt" || mode === "stop") {
    if (source === "enter") return verdict("none", "Type a message to send");
    return verdict(
      "stop",
      blocked ??
        (!facts.connected
          ? "Reconnect to stop"
          : !facts.stopSupported
          ? "Stopping is not supported here"
          : facts.stopping
          ? "Stopping"
          : !canStop(facts)
          ? "There is no response to stop"
          : undefined),
    );
  }

  const kind = facts.content || facts.chips.length ? "send" : "none";
  if (facts.local && !blocked) return verdict("send");
  return verdict(
    kind,
    blocked ??
      (!facts.connected
        ? kind === "send" ? "Reconnecting - message kept" : "Reconnect to send"
        : !facts.supported
        ? "Sending is not supported here"
        : facts.chips.some((chip) => chip.error)
        ? "Remove or retry the failed attachment"
        : facts.chips.some((chip) => chip.pending)
        ? "Waiting for attachment"
        : !facts.content
        ? "Write a message"
        : facts.sending
        ? "Previous message still sending"
        : undefined),
  );
}

export interface ComposerActionOwner {
  readonly state: PrimaryActionState<ComposerMode> & { sending: boolean };
  verdict(source: ComposerSource): ComposerVerdict;
  subscribe(listener: () => void): () => void;
  activate(source: ComposerSource): Promise<void>;
}

export function createComposerAction<T>(options: {
  facts(draft: T): Omit<ComposerFacts, "sending" | "local">;
  draft(): T;
  local?(draft: T): (() => Promise<void>) | undefined;
  prepare(): Promise<void>;
  send(draft: T, activation: string): Promise<void>;
  stop(): Promise<void>;
  refuse(
    reason: string,
    source: ComposerSource,
    recheckAs: ComposerSource,
  ): void;
  begin(): void;
}): ComposerActionOwner {
  let sending = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const project = (source: ComposerSource, draft: T, current = false) => {
    const facts = options.facts(draft);
    const local = source === "interrupt" ? undefined : options.local?.(draft);
    return {
      verdict: composerAction({
        ...facts,
        sending: sending && !current,
        local: !!local,
      }, source),
      facts,
      local,
    };
  };
  return {
    verdict: (source: ComposerSource) =>
      project(source, options.draft()).verdict,
    get state(): PrimaryActionState<ComposerMode> & { sending: boolean } {
      const { verdict, facts, local } = project("button", options.draft());
      const mode = verdict.kind === "stop" ? "stop" : "send";
      return {
        ...verdict,
        mode,
        label: composerLabel(mode),
        visible: true,
        sending,
        pending: mode === "stop" ? !!facts.stopping : sending && !local,
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async activate(source: ComposerSource): Promise<void> {
      const activation = randomID();
      sendDiagnostic("activation", { activation, state: source });
      const refuse = (reason: string, recheckAs = source) => {
        sendDiagnostic("refused", { activation, state: reason });
        options.refuse(reason, source, recheckAs);
      };
      const initial = project(source, options.draft());
      if (initial.verdict.reason) return refuse(initial.verdict.reason);
      if (initial.verdict.kind === "stop") {
        options.begin();
        return await options.stop();
      }
      if (initial.local) {
        options.begin();
        return await initial.local();
      }

      sending = true;
      try {
        options.begin();
        publish();
        await options.prepare();
        const draft = options.draft();
        // An attempt to send can never turn into Stop while preparing.
        const prepared = project("enter", draft, true);
        if (prepared.verdict.reason) {
          return refuse(prepared.verdict.reason, "enter");
        }
        if (prepared.local) return await prepared.local();
        sendDiagnostic("admitted", { activation });
        await options.send(draft, activation);
      } catch (cause) {
        sendDiagnostic("refused", { activation });
        throw cause;
      } finally {
        sending = false;
        publish();
      }
    },
  };
}
