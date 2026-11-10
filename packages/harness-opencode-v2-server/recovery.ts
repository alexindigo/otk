// SPDX-License-Identifier: LGPL-3.0-only
import type { NativeMessage } from "./messages.ts";
interface Owner {
  session: string;
  message: string;
  parts: Set<string>;
  generation: number;
  terminal: boolean;
  failed: boolean;
  checkpoint?: string;
  controller?: AbortController;
  queued: boolean;
}
/** One replacement read per missing seed, bounded across the adapter. Deltas never rearm. */
export class MessageRecovery {
  #owners = new Map<string, Owner>();
  #scopes = new Set<string>();
  #ended = new Map<string, Set<string>>();
  #tasks = new Set<Promise<void>>();
  #generation = 0;
  #scheduled = false;
  constructor(
    readonly options: {
      concurrency: number;
      pending: number;
      wanted(session: string): boolean;
      read(
        session: string,
        message: string,
        signal: AbortSignal,
      ): Promise<NativeMessage>;
      emit(
        session: string,
        snapshot: NativeMessage,
        parts: ReadonlySet<string>,
        generation: number,
        terminal: boolean,
        signal: AbortSignal,
      ): void | Promise<void>;
      state(
        session: string,
        message: string,
        part: string,
        generation: number,
        state: "recovering" | "ready" | "unavailable",
      ): void;
      reconcile(session: string): void;
      failed(error: unknown): void;
    },
  ) {}
  #key(session: string, message: string): string {
    return JSON.stringify([session, message]);
  }
  #size(): number {
    let n = 0;
    for (const o of this.#owners.values()) n += o.parts.size;
    for (const e of this.#ended.values()) n += e.size;
    return n;
  }
  touch(session: string, message: string, part: string): void {
    if (
      !this.options.wanted(session) || this.#scopes.has(session) ||
      this.#ended.get(session)?.has(message)
    ) return;
    const key = this.#key(session, message);
    let owner = this.#owners.get(key);
    if (owner?.parts.has(part)) return;
    if (this.#size() >= this.options.pending) {
      this.release(session);
      this.#scopes.add(session);
      this.options.reconcile(session);
      return;
    }
    if (!owner) {
      owner = {
        session,
        message,
        parts: new Set(),
        generation: ++this.#generation,
        terminal: false,
        failed: false,
        queued: true,
      };
      this.#owners.set(key, owner);
    }
    owner.parts.add(part);
    this.options.state(
      session,
      message,
      part,
      owner.generation,
      owner.failed ? "unavailable" : "recovering",
    );
    this.#schedule();
  }
  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }
  #drain(): void {
    for (const [key, owner] of this.#owners) {
      if (!this.options.wanted(owner.session)) {
        this.message(owner.message, owner.session);
        continue;
      }
      if (this.#tasks.size >= this.options.concurrency) return;
      if (!owner.queued || owner.controller) continue;
      owner.queued = false;
      const controller = owner.controller = new AbortController(),
        generation = owner.generation,
        terminal = owner.terminal;
      const current = () =>
        this.#owners.get(key) === owner && generation === owner.generation &&
        !controller.signal.aborted;
      const task = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return this.options.read(
          owner.session,
          owner.message,
          controller.signal,
        );
      }).then(async (raw) => {
        if (!current()) return;
        if (raw.id !== owner.message) {
          throw new Error("Recovery message identity mismatch");
        }
        await this.options.emit(
          owner.session,
          raw,
          owner.parts,
          generation,
          terminal,
          controller.signal,
        );
        if (!current()) return;
        owner.failed = false;
        if (terminal) {
          for (const part of owner.parts) {
            this.options.state(
              owner.session,
              owner.message,
              part,
              generation,
              "ready",
            );
          }
          this.message(owner.message, owner.session);
          let ended = this.#ended.get(owner.session);
          if (!ended) this.#ended.set(owner.session, ended = new Set());
          ended.add(owner.message);
        }
      }).catch((error) => {
        if (!current()) return;
        owner.failed = true;
        for (const part of owner.parts) {
          this.options.state(
            owner.session,
            owner.message,
            part,
            generation,
            "unavailable",
          );
        }
        this.options.failed(error);
      }).finally(() => {
        this.#tasks.delete(task);
        if (owner.controller === controller) owner.controller = undefined;
        this.#schedule();
      });
      this.#tasks.add(task);
    }
  }
  #replace(owner: Owner, terminal: boolean): void {
    owner.controller?.abort();
    owner.generation = ++this.#generation;
    owner.terminal = terminal;
    owner.failed = false;
    owner.queued = true;
    for (const part of owner.parts) {
      this.options.state(
        owner.session,
        owner.message,
        part,
        owner.generation,
        "recovering",
      );
    }
    this.#schedule();
  }
  terminal(session: string, message?: string): boolean {
    if (this.#scopes.has(session)) this.options.reconcile(session);
    let found = false;
    for (const owner of this.#owners.values()) {
      if (
        owner.session === session &&
        (message === undefined || message === owner.message)
      ) {
        found = true;
        if (!owner.terminal) this.#replace(owner, true);
      }
    }
    return found;
  }
  checkpoint(session: string, message: string, checkpoint: string): void {
    const owner = this.#owners.get(this.#key(session, message));
    if (owner && owner.checkpoint !== checkpoint) {
      owner.checkpoint = checkpoint;
      if (owner.failed) this.#replace(owner, owner.terminal);
    }
  }
  retry(session: string): void {
    for (const owner of this.#owners.values()) {
      if (owner.session === session && owner.failed) {
        this.#replace(owner, owner.terminal);
      }
    }
  }
  snapshot(
    session: string,
  ): { messageID: string; partID: string; generation: number }[] {
    return [...this.#owners.values()].filter((o) => o.session === session)
      .flatMap((o) =>
        [...o.parts].map((partID) => ({
          messageID: o.message,
          partID,
          generation: o.generation,
        }))
      );
  }
  scoped(session: string): boolean {
    return this.#scopes.has(session);
  }
  part(message: string, part: string, session: string): void {
    const owner = this.#owners.get(this.#key(session, message));
    if (!owner?.parts.delete(part)) return;
    this.options.state(session, message, part, owner.generation, "ready");
    if (!owner.parts.size) this.message(message, session);
  }
  message(message: string, session: string): void {
    const key = this.#key(session, message), owner = this.#owners.get(key);
    if (owner) {
      this.#owners.delete(key);
      owner.controller?.abort();
    }
  }
  restart(session: string, message: string): void {
    this.message(message, session);
    this.#ended.get(session)?.delete(message);
  }
  release(session?: string): void {
    for (const owner of this.#owners.values()) {
      if (session === undefined || owner.session === session) {
        this.message(owner.message, owner.session);
      }
    }
    if (session === undefined) {
      this.#scopes.clear();
      this.#ended.clear();
    } else {
      this.#scopes.delete(session);
      this.#ended.delete(session);
    }
  }
  async stop(): Promise<void> {
    this.release();
    await Promise.all(this.#tasks);
  }
}
