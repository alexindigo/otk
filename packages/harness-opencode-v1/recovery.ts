// SPDX-License-Identifier: LGPL-3.0-only
import type { NativeMessage } from "./messages.ts";

interface Recovery {
  session: string;
  message: string;
  parts: Set<string>;
  generation: number;
  phase: "queued" | "snapshot" | "awaiting-event" | "terminal";
  terminal: boolean;
  checkpoint?: string;
  failed: boolean;
  read?: AbortController;
}
export interface RecoveryOptions {
  concurrency: number;
  pending: number;
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
  ): void;
  state(
    session: string,
    message: string,
    part: string,
    generation: number,
    state: "recovering" | "ready" | "unavailable",
  ): void;
  reconcile(session: string): void;
  failed(error: unknown): void;
}
/** HTTP checkpoints are replacements, never event-aligned append seeds. */
export class MessageRecovery {
  #sessions = new Map<string, Map<string, Recovery>>();
  #scopes = new Map<string, { terminal: boolean; checkpoint?: string }>();
  #ended = new Map<string, Set<string>>();
  #endedKeys = 0;
  #queue = new Set<Recovery>();
  #pending = new Set<Promise<void>>();
  #keys = 0;
  #generation = 0;
  #scheduled = false;
  constructor(readonly options: RecoveryOptions) {}
  #current(owner: Recovery): boolean {
    return this.#sessions.get(owner.session)?.get(owner.message) === owner;
  }
  touch(session: string, message: string, part: string): void {
    if (this.#scopes.has(session) || this.#ended.get(session)?.has(message)) {
      return;
    }
    let owner = this.#sessions.get(session)?.get(message);
    if (owner?.parts.has(part)) return;
    if (this.#keys + this.#endedKeys >= this.options.pending) {
      this.release(session);
      this.#scopes.set(session, { terminal: false });
      this.options.reconcile(session);
      return;
    }
    if (!owner) {
      owner = {
        session,
        message,
        parts: new Set(),
        generation: ++this.#generation,
        phase: "queued",
        terminal: false,
        failed: false,
      };
      let messages = this.#sessions.get(session);
      if (!messages) this.#sessions.set(session, messages = new Map());
      messages.set(message, owner);
      this.#queue.add(owner);
    }
    owner.parts.add(part);
    this.#keys++;
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
    for (const owner of this.#queue) {
      if (this.#pending.size >= this.options.concurrency) return;
      // An aborted request still owns its slot until its reader settles. Join
      // it before admitting this message's replacement generation.
      if (owner.read) continue;
      this.#queue.delete(owner);
      if (!this.#current(owner)) continue;
      const read = owner.read = new AbortController();
      const generation = owner.generation, terminal = owner.terminal;
      owner.phase = terminal ? "terminal" : "snapshot";
      const current = () =>
        this.#current(owner) && owner.generation === generation &&
        !read.signal.aborted;
      const task = Promise.resolve().then(() => {
        read.signal.throwIfAborted();
        return this.options.read(owner.session, owner.message, read.signal);
      }).then((snapshot) => {
        if (!current()) return;
        if (snapshot.info.id !== owner.message) {
          throw new Error("Recovery message identity mismatch");
        }
        this.options.emit(
          owner.session,
          snapshot,
          owner.parts,
          generation,
          terminal,
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
          if (!current()) return;
          this.message(owner.message, owner.session);
          let ended = this.#ended.get(owner.session);
          if (!ended) this.#ended.set(owner.session, ended = new Set());
          if (!ended.has(owner.message)) {
            ended.add(owner.message);
            this.#endedKeys++;
          }
        } else owner.phase = "awaiting-event";
      }).catch((error) => {
        if (!current()) return;
        owner.failed = true;
        owner.phase = "awaiting-event";
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
        this.#pending.delete(task);
        if (owner.read === read) owner.read = undefined;
        this.#schedule();
      });
      this.#pending.add(task);
    }
  }
  #replace(owner: Recovery, terminal: boolean): void {
    owner.read?.abort();
    owner.generation = ++this.#generation;
    owner.terminal = terminal;
    owner.failed = false;
    owner.phase = "queued";
    for (const part of owner.parts) {
      this.options.state(
        owner.session,
        owner.message,
        part,
        owner.generation,
        "recovering",
      );
    }
    this.#queue.add(owner);
    this.#schedule();
  }
  terminal(session: string, message?: string): boolean {
    const scope = this.#scopes.get(session);
    if (scope && !scope.terminal) {
      scope.terminal = true;
      this.options.reconcile(session);
    }
    let found = false;
    for (const owner of this.#sessions.get(session)?.values() ?? []) {
      if (message !== undefined && owner.message !== message) continue;
      found = true;
      if (!owner.terminal) this.#replace(owner, true);
    }
    return found;
  }
  checkpoint(session: string, message: string, checkpoint: string): void {
    const scope = this.#scopes.get(session);
    if (scope && scope.checkpoint !== `${message}:${checkpoint}`) {
      scope.checkpoint = `${message}:${checkpoint}`;
      scope.terminal = false;
    }
    const owner = this.#sessions.get(session)?.get(message);
    if (!owner || owner.checkpoint === checkpoint) return;
    owner.checkpoint = checkpoint;
    if (owner.failed) this.#replace(owner, owner.terminal);
  }
  retry(session: string): void {
    for (const owner of this.#sessions.get(session)?.values() ?? []) {
      if (owner.failed) this.#replace(owner, owner.terminal);
    }
  }
  snapshot(
    session: string,
  ): { messageID: string; partID: string; generation: number }[] {
    return [...this.#sessions.get(session)?.values() ?? []].flatMap((owner) =>
      [...owner.parts].map((partID) => ({
        messageID: owner.message,
        partID,
        generation: owner.generation,
      }))
    );
  }
  scoped(session: string): boolean {
    return this.#scopes.has(session);
  }
  part(message: string, part: string, session: string): void {
    const owner = this.#sessions.get(session)?.get(message);
    if (!owner?.parts.delete(part)) return;
    this.#keys--;
    this.options.state(session, message, part, owner.generation, "ready");
    if (!owner.parts.size) this.message(message, session);
  }
  message(message: string, session: string): void {
    const messages = this.#sessions.get(session),
      owner = messages?.get(message);
    if (!owner) return;
    messages!.delete(message);
    if (!messages!.size) this.#sessions.delete(session);
    this.#keys -= owner.parts.size;
    this.#queue.delete(owner);
    owner.read?.abort();
  }
  release(session?: string): void {
    for (const [id, messages] of this.#sessions) {
      if (session !== undefined && session !== id) continue;
      for (const message of messages.keys()) this.message(message, id);
    }
    if (session === undefined) this.#scopes.clear();
    else this.#scopes.delete(session);
    for (const [id, ended] of this.#ended) {
      if (session !== undefined && session !== id) continue;
      this.#endedKeys -= ended.size;
      this.#ended.delete(id);
    }
  }
  async stop(): Promise<void> {
    this.release();
    await Promise.all(this.#pending);
  }
}
