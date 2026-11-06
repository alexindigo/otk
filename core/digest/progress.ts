// SPDX-License-Identifier: LGPL-3.0-only
import type { ProgressFacts } from "@otk/protocol";

/** Incremental counts from the worker's existing bounded enumeration. No SQL. */
export class DigestProgress {
  #rows = new Map<
    string,
    { directory: string; ready: boolean; messages: number }
  >();
  #scopes = new Map<string | undefined, ProgressFacts>();
  #complete = false;
  constructor(readonly generation: string, readonly now = Date.now) {
    this.#scope(undefined);
  }
  #scope(directory: string | undefined): ProgressFacts {
    let value = this.#scopes.get(directory);
    if (!value) {
      const now = this.now();
      value = {
        generation: this.generation,
        directory,
        phase: "enumerating",
        eligible: null,
        completed: 0,
        queued: 0,
        chunks: 0,
        messages: 0,
        activeMs: 0,
        started: now,
        advanced: now,
      };
      this.#scopes.set(directory, value);
    }
    return value;
  }
  row(id: string, directory: string, ready: boolean, messages = 0): void {
    const previous = this.#rows.get(id);
    if (
      previous?.directory === directory && previous.ready === ready &&
      previous.messages === messages
    ) return;
    if (previous) this.#contribute(previous, -1);
    const next = { directory, ready, messages };
    this.#rows.set(id, next);
    this.#contribute(next, 1);
  }
  update(
    id: string,
    ready: boolean,
    messages: number,
    directory = this.#rows.get(id)?.directory,
  ): void {
    if (directory !== undefined) this.row(id, directory, ready, messages);
  }
  #contribute(
    row: { directory: string; ready: boolean; messages: number },
    sign: number,
  ): void {
    for (const key of [undefined, row.directory]) {
      const scope = this.#scope(key);
      scope.eligible = (scope.eligible ?? 0) + sign;
      scope.completed += sign * Number(row.ready);
      scope.messages += sign * row.messages;
      scope.queued = scope.eligible - scope.completed;
      scope.advanced = this.now();
    }
  }
  complete(): void {
    this.#complete = true;
  }
  chunk(directory: string | undefined, activeMs: number): void {
    for (
      const key of directory === undefined
        ? [undefined]
        : [undefined, directory]
    ) {
      const value = this.#scope(key);
      value.chunks++;
      value.activeMs += Math.max(0, activeMs);
      value.advanced = this.now();
    }
  }
  values(wait?: string): ProgressFacts[] {
    return [...this.#scopes.values()].map((scope) => ({
      ...scope,
      eligible: this.#complete ? scope.eligible ?? 0 : null,
      phase: !this.#complete
        ? "enumerating"
        : scope.queued
        ? "summaries"
        : "ready",
      wait: scope.queued || !this.#complete ? wait : undefined,
    }));
  }
}
