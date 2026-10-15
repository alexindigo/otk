// SPDX-License-Identifier: LGPL-3.0-only
import type { NativeMessage } from "./messages.ts";

interface Recovery {
  session: string;
  message: string;
  parts: Set<string>;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  running?: Promise<void>;
}

/** Snapshots render only: without a native offset they can never seed appends. */
export class MessageRecovery {
  #messages = new Map<string, Recovery>();
  #pending = new Set<Promise<void>>();
  constructor(
    readonly read: (
      session: string,
      message: string,
      signal: AbortSignal,
    ) => Promise<NativeMessage>,
    readonly emit: (
      session: string,
      snapshot: NativeMessage,
      parts: ReadonlySet<string>,
    ) => void,
    readonly failed: (error: unknown) => void,
    readonly milliseconds = 50,
  ) {}
  touch(session: string, message: string, part: string): void {
    let owner = this.#messages.get(message);
    if (owner && owner.session !== session) return;
    if (!owner) {
      owner = {
        session,
        message,
        parts: new Set(),
        dirty: false,
        controller: new AbortController(),
      };
      this.#messages.set(message, owner);
    }
    owner.parts.add(part);
    owner.dirty = true;
    this.#schedule(owner);
  }
  #schedule(owner: Recovery): void {
    if (owner.timer !== undefined || owner.running) return;
    owner.timer = setTimeout(() => {
      owner.timer = undefined;
      owner.dirty = false;
      const task = this.read(
        owner.session,
        owner.message,
        AbortSignal.any([
          owner.controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      ).then((snapshot) => {
        if (this.#messages.get(owner.message) === owner && owner.parts.size) {
          this.emit(owner.session, snapshot, owner.parts);
        }
      }).catch((error) => {
        if (!owner.controller.signal.aborted) this.failed(error);
      }).finally(() => {
        this.#pending.delete(task);
        owner.running = undefined;
        if (this.#messages.get(owner.message) !== owner) return;
        if (owner.dirty) this.#schedule(owner);
        else this.#messages.delete(owner.message);
      });
      owner.running = task;
      this.#pending.add(task);
    }, this.milliseconds);
  }
  part(message: string, part: string): void {
    const owner = this.#messages.get(message);
    owner?.parts.delete(part);
    if (owner && !owner.parts.size) this.message(message);
  }
  message(message: string): void {
    const owner = this.#messages.get(message);
    if (!owner) return;
    this.#messages.delete(message);
    clearTimeout(owner.timer);
    owner.controller.abort();
  }
  release(session?: string): void {
    for (const [message, owner] of this.#messages) {
      if (session === undefined || owner.session === session) {
        this.message(message);
      }
    }
  }
  async stop(): Promise<void> {
    this.release();
    await Promise.all(this.#pending);
  }
}
