// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";
import type { SidecarConnection } from "./connection.ts";

export type TerminalBoxMode = "closed" | "docked" | "expanded";
/** Browser-memory presentation intent, independent of mounted views/channels. */
export class TerminalBox {
  #mode: TerminalBoxMode = "closed";
  #store;
  constructor(factory: StateFactory = createState) {
    this.#store = factory({ revision: 0 });
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
    this.#store.update((state) => {
      state.revision++;
    });
  }
  toggle(): void {
    this.#set(this.#mode === "closed" ? "docked" : "closed");
  }
  expand(): void {
    if (this.#mode === "docked") this.#set("expanded");
  }
  collapse(): void {
    if (this.#mode === "expanded") this.#set("docked");
  }
  close(): void {
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
  boxes.delete(connection);
}
