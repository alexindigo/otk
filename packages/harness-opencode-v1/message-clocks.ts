// SPDX-License-Identifier: LGPL-3.0-only
import type { ProviderReadPort } from "@otk/harness";
/** Optional scalar demand; execution/admission remain in the injected scheduler. */
export class MessageClocks {
  #pending = new Map<
    string,
    { session: string; message: string; controller: AbortController }
  >();
  #dirty = new Set<string>();
  constructor(
    readonly reads: ProviderReadPort,
    readonly limit: number,
    readonly reconcile: (session: string) => void,
    readonly failed: (error: unknown) => void,
  ) {}
  request(
    session: string,
    message: string,
    signal: AbortSignal,
    publish: (lastOutput: number) => void,
  ): void {
    const key = JSON.stringify([session, message]);
    if (this.#pending.has(key)) return;
    if (this.#pending.size >= this.limit) {
      this.#dirty.add(session);
      return;
    }
    const controller = new AbortController();
    const owner = { session, message, controller };
    this.#pending.set(key, owner);
    const combined = AbortSignal.any([signal, controller.signal]);
    void this.reads.read("message.clock", {
      sessionID: session,
      messageID: message,
    }, {
      owner: JSON.stringify([
        "message.clock",
        session,
        message,
        crypto.randomUUID(),
      ]),
      priority: "visible",
      signal: combined,
    }).then(({ lastOutput }) => {
      if (
        !combined.aborted && this.#pending.get(key) === owner &&
        lastOutput !== null
      ) publish(lastOutput);
    }).catch((error) => {
      if (!combined.aborted) this.failed(error);
    }).finally(() => {
      if (this.#pending.get(key) === owner) this.#pending.delete(key);
      if (!this.#pending.size) {
        const dirty = [...this.#dirty];
        this.#dirty.clear();
        for (const id of dirty) this.reconcile(id);
      }
    });
  }
  release(session?: string, message?: string): void {
    for (const [key, owner] of this.#pending) {
      if (
        (session === undefined || owner.session === session) &&
        (message === undefined || owner.message === message)
      ) {
        this.#pending.delete(key);
        owner.controller.abort();
      }
    }
    if (session === undefined) this.#dirty.clear();
    else this.#dirty.delete(session);
  }
}
