// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { SidecarConnection } from "./connection.ts";
import { RequestFailure } from "./failures.ts";
import { TERMINAL_RUN_LABEL, TerminalRuns } from "./terminal-runs.ts";

export const TERMINALS_UNAVAILABLE =
  "Terminals are unavailable on this OTK server";
const closedReason = "The terminal was closed before the command ran.";

function unavailableFailure(reason = closedReason): RequestFailure {
  return new RequestFailure({
    code: "terminal.unavailable",
    retry: "new-intent",
    diagnosticID: randomID(),
    facts: { actionLabel: TERMINAL_RUN_LABEL, reason },
  });
}

const panelFailures = new WeakSet<object>();
export function terminalRunFailureOwned(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null &&
    panelFailures.has(cause);
}

export type TerminalBoxMode = "closed" | "docked" | "expanded";
/** Browser-memory presentation intent, independent of mounted views/channels. */
export class TerminalBox {
  #mode: TerminalBoxMode = "closed";
  #unavailable: string | undefined;
  readonly runs: TerminalRuns;
  #store;
  constructor(factory: StateFactory = createState) {
    this.#store = factory({ revision: 0 });
    this.runs = new TerminalRuns(factory, {
      unavailable: () => this.#unavailable,
      unavailableFailure,
      ownFailure: (cause) => panelFailures.add(cause),
      queued: () => {
        if (this.#mode === "closed") this.#set("docked");
        else this.#changed();
      },
    });
  }
  get mode(): TerminalBoxMode {
    void this.#store.state.revision;
    return this.#mode;
  }
  subscribe(listener: (mode: TerminalBoxMode) => void): () => void {
    return this.#store.subscribe(() => listener(this.#mode));
  }
  #set(mode: TerminalBoxMode): void {
    if (this.#mode === mode) return;
    this.#mode = mode;
    this.#changed();
  }
  #changed(): void {
    this.#store.update((state) => {
      state.revision++;
    });
  }
  get unavailable(): string | undefined {
    void this.#store.state.revision;
    return this.#unavailable;
  }
  markUnavailable(reason: string | undefined): void {
    if (reason === this.#unavailable) return;
    this.#unavailable = reason;
    this.#changed();
  }
  /** Open this session's dock and wait for delivery to its selected shell. */
  run(text: string): Promise<void> {
    return this.runs.request(text, "submit");
  }
  paste(text: string): Promise<void> {
    return this.runs.request(text, "confirm");
  }
  toggle(): void {
    if (this.#mode === "closed") this.#set("docked");
    else this.close();
  }
  expand(): void {
    if (this.#mode === "docked") this.#set("expanded");
  }
  collapse(): void {
    if (this.#mode === "expanded") this.#set("docked");
  }
  close(): void {
    this.runs.hidden();
    this.#set("closed");
  }
  release(): void {
    this.runs.release();
    this.#set("closed");
  }
}

const boxes = new WeakMap<SidecarConnection, Map<string, TerminalBox>>();
export function terminalBoxFor(
  connection: SidecarConnection,
  sessionID: string,
  factory: StateFactory = createState,
): TerminalBox {
  let sessions = boxes.get(connection);
  if (!sessions) boxes.set(connection, sessions = new Map());
  let box = sessions.get(sessionID);
  if (!box) sessions.set(sessionID, box = new TerminalBox(factory));
  return box;
}
/** The connection owner retires its presentation memory when removed/stopped. */
export function releaseTerminalBoxes(connection: SidecarConnection): void {
  for (const box of boxes.get(connection)?.values() ?? []) box.release();
  boxes.delete(connection);
}
