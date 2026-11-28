// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import { RequestFailure } from "./failures.ts";
import type { StateFactory } from "./state.ts";

export const TERMINAL_RUN_LABEL = "Run in terminal";

export type TerminalRunMode = "submit" | "confirm";
export type TerminalRunPhase =
  | "queued"
  | "pending"
  | "submitted"
  | "cancelled"
  | "released"
  | "failed";

export interface TerminalRun {
  readonly id: string;
  readonly text: string;
  readonly mode: TerminalRunMode;
  readonly phase: TerminalRunPhase;
  readonly terminalID?: string;
}

/** The panel's write port for one attached terminal. Only the run owner calls it. */
export interface TerminalRunTarget {
  readonly terminalID: string;
  bracketedPaste(): boolean;
  paste(text: string): void;
  submit(): void;
  erase(count: number): void;
}

interface RunIntent {
  state: TerminalRun;
  resolve(): void;
  reject(cause: unknown): void;
}

interface BoxRunPorts {
  unavailable(): string | undefined;
  unavailableFailure(reason?: string): RequestFailure;
  ownFailure(cause: object): void;
  queued(): void;
}

export function normalizeRunText(text: string): string {
  return text.replace(/\r\n?/g, "\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

export function runnableText(
  { selection, span }: { selection?: string; span?: string },
): string | undefined {
  return normalizeRunText(selection ?? "") || normalizeRunText(span ?? "") ||
    undefined;
}

export function runLabel(text: string): string {
  const [first, ...rest] = text.split("\n");
  const points = Array.from(first);
  return `${TERMINAL_RUN_LABEL}: ${points.slice(0, 40).join("")}${
    points.length > 40 || rest.length ? "..." : ""
  }`;
}

export function eraseCount(text: string): number {
  let count = 0;
  // Readline deletes the base and its combining marks with one DEL.
  for (const character of text) {
    if (!/[\p{Mn}\p{Me}\u200b-\u200d\ufe0e\ufe0f]/u.test(character)) count++;
  }
  return count;
}

/** Owns all programmatic terminal input for a session (decision 73). */
export class TerminalRuns {
  #store;
  #queued: RunIntent[] = [];
  #pending?: RunIntent;
  #targets = new Map<string, TerminalRunTarget>();
  #released = false;
  #delivering = false;

  constructor(factory: StateFactory, private box: BoxRunPorts) {
    this.#store = factory({ revision: 0 });
  }

  #changed(): void {
    this.#store.update((state) => state.revision++);
  }

  get pending(): TerminalRun | undefined {
    void this.#store.state.revision;
    return this.#pending?.state;
  }

  get waiting(): boolean {
    void this.#store.state.revision;
    return this.#queued.length > 0;
  }

  ready(terminalID: string): boolean {
    void this.#store.state.revision;
    return this.#targets.has(terminalID);
  }

  request(text: string, mode: TerminalRunMode): Promise<void> {
    const unavailable = this.box.unavailable();
    if (this.#released || unavailable) {
      return Promise.reject(this.box.unavailableFailure(unavailable));
    }
    text = normalizeRunText(text);
    if (!text) return Promise.resolve();
    if (mode === "confirm") {
      this.#queued = this.#queued.filter((run) => {
        if (run.state.mode === "submit") return true;
        this.#end(run, "cancelled");
        return false;
      });
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#queued.push({
      state: { id: randomID(), text, mode, phase: "queued" },
      resolve,
      reject,
    });
    this.#changed();
    this.box.queued();
    return promise;
  }

  attach(target: TerminalRunTarget): () => void {
    if (this.#released) return () => {};
    this.#targets.set(target.terminalID, target);
    this.#changed();
    return () => {
      if (this.#targets.get(target.terminalID) !== target) return;
      this.#targets.delete(target.terminalID);
      this.#changed();
    };
  }

  #end(
    run: RunIntent,
    phase: Exclude<TerminalRunPhase, "queued" | "pending">,
    cause?: unknown,
  ): void {
    run.state = { ...run.state, phase };
    if (this.#pending === run) this.#pending = undefined;
    if (phase === "failed") run.reject(cause);
    else run.resolve();
  }

  deliver(terminalID: string): void {
    const target = this.#targets.get(terminalID);
    if (!target || !this.#queued.length || this.#delivering) return;
    this.#delivering = true;
    try {
      while (this.#targets.get(terminalID) === target) {
        const run = this.#queued.shift();
        if (!run) break;
        try {
          const previous = this.#pending?.state.terminalID;
          if (this.#pending && previous && !this.cancel()) {
            this.#end(this.#pending, "released");
          }
          const { text, mode } = run.state;
          if (
            mode === "confirm" && /[\n\t]/.test(text) &&
            !target.bracketedPaste()
          ) {
            this.#end(
              run,
              "failed",
              new RequestFailure({
                code: "terminal.unbracketed",
                retry: "new-intent",
                diagnosticID: randomID(),
                facts: {
                  actionLabel: TERMINAL_RUN_LABEL,
                  reason:
                    "This shell would run each line at once, so OTK did not paste it.",
                },
              }),
            );
            continue;
          }
          target.paste(text);
          run.state = { ...run.state, terminalID };
          if (mode === "submit") {
            target.submit();
            this.#end(run, "submitted");
          } else {
            run.state = { ...run.state, phase: "pending" };
            this.#pending = run;
            run.resolve();
          }
        } catch (cause) {
          this.#end(run, "failed", cause);
          if (typeof cause === "object" && cause !== null) {
            this.box.ownFailure(cause);
          }
          this.#failQueued(cause);
          throw cause;
        }
      }
    } finally {
      this.#delivering = false;
      this.#changed();
    }
  }

  #act(
    phase: "submitted" | "cancelled",
    write: (target: TerminalRunTarget, text: string) => void,
  ): boolean {
    const run = this.#pending;
    const target = run?.state.terminalID &&
      this.#targets.get(run.state.terminalID);
    if (!run || !target) return false;
    try {
      write(target, run.state.text);
      this.#end(run, phase);
      return true;
    } catch (cause) {
      this.#end(run, "failed", cause);
      throw cause;
    } finally {
      if (!this.#delivering) this.#changed();
    }
  }

  confirm(): boolean {
    return this.#act("submitted", (target) => target.submit());
  }

  cancel(): boolean {
    return this.#act(
      "cancelled",
      (target, text) => target.erase(eraseCount(text)),
    );
  }

  input(terminalID: string): void {
    if (this.#pending?.state.terminalID !== terminalID) return;
    this.#end(this.#pending, "released");
    this.#changed();
  }

  present(terminalIDs: readonly string[]): void {
    const terminalID = this.#pending?.state.terminalID;
    if (terminalID && !terminalIDs.includes(terminalID)) this.input(terminalID);
  }

  #failQueued(cause: unknown): void {
    for (const run of this.#queued.splice(0)) this.#end(run, "failed", cause);
  }

  fail(cause: object): void {
    this.box.ownFailure(cause);
    if (!this.#queued.length) return;
    this.#failQueued(cause);
    this.#changed();
  }

  hidden(): void {
    if (!this.#queued.length) return;
    this.#failQueued(this.box.unavailableFailure());
    this.#changed();
  }

  release(): void {
    this.#released = true;
    this.#targets.clear();
    if (this.#pending) this.#end(this.#pending, "released");
    this.#failQueued(this.box.unavailableFailure());
    this.#changed();
  }
}
