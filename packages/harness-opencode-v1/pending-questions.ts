// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type QuestionRequest,
  type SessionLookup,
} from "@otk/protocol";
export interface PendingQuestion {
  request: QuestionRequest;
  directory?: string;
  generation: number;
}
interface Capture {
  directory: string;
  generation: number;
  changes: Map<string, PendingQuestion | undefined>;
  overflow: boolean;
}
/** One live pending metadata owner, independent of body/catalog subscribers. */
export class PendingQuestions {
  #values = new Map<string, PendingQuestion>();
  #captures = new Set<Capture>();
  #generation = 0;
  #known = new Set<string>();
  constructor(
    readonly pending: number,
    readonly changed: (
      before: PendingQuestion | undefined,
      after: PendingQuestion | undefined,
    ) => void = () => {},
  ) {}
  known(directory: string): boolean {
    return this.#known.has(directory);
  }
  uncertain(): void {
    this.#known.clear();
  }
  get size(): number {
    return this.#values.size;
  }
  get(id: string): PendingQuestion | undefined {
    const value = this.#values.get(id);
    return value ? structuredClone(value) : undefined;
  }
  *values(): Iterable<PendingQuestion> {
    for (const value of this.#values.values()) yield structuredClone(value);
  }
  list(session: string, entry: SessionLookup): QuestionRequest[] {
    return [...this.#values.values()].filter(({ request }) =>
      belongsToSession(request.sessionID, session, entry)
    ).map(({ request }) => structuredClone(request)).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
  }
  directory(directory: string): QuestionRequest[] {
    return [...this.#values.values()].filter((value) =>
      value.directory === directory
    ).map(({ request }) => structuredClone(request));
  }
  upsert(request: QuestionRequest, directory?: string): void {
    const value = {
      request: structuredClone(request),
      directory,
      generation: this.#generation,
    };
    const before = this.#values.get(request.id);
    if (before && before.directory !== directory) {
      for (const capture of this.#captures) {
        if (capture.directory === before.directory) {
          this.#change(capture, request.id, undefined);
        }
      }
    }
    this.#values.set(request.id, value);
    if (directory !== undefined) this.#record(request.id, directory, value);
    this.changed(before, value);
  }
  remove(id: string): void {
    const before = this.#values.get(id);
    this.#values.delete(id);
    if (before) this.changed(before, undefined);
    for (const capture of this.#captures) {
      if (!before || capture.directory === before.directory) {
        this.#change(capture, id, undefined);
      }
    }
  }
  #change(
    capture: Capture,
    id: string,
    value: PendingQuestion | undefined,
  ): void {
    if (capture.overflow) return;
    capture.changes.set(id, value);
    if (capture.changes.size > this.pending) {
      capture.changes.clear();
      capture.overflow = true;
    }
  }
  #record(id: string, directory: string, value: PendingQuestion): void {
    for (const capture of this.#captures) {
      if (capture.directory === directory) this.#change(capture, id, value);
    }
  }
  capture(directory: string): {
    commit(values: QuestionRequest[]): boolean;
    release(): void;
  } {
    const capture: Capture = {
      directory,
      generation: this.#generation,
      changes: new Map(),
      overflow: false,
    };
    this.#captures.add(capture);
    return {
      commit: (values) => {
        if (
          !this.#captures.delete(capture) ||
          capture.generation !== this.#generation || capture.overflow
        ) return false;
        const next = new Map<string, PendingQuestion>(
          values.map((
            request,
          ) => [request.id, {
            request: structuredClone(request),
            directory,
            generation: this.#generation,
          }]),
        );
        for (const [id, value] of capture.changes) {
          if (value) next.set(id, value);
          else next.delete(id);
        }
        for (const [id, value] of this.#values) {
          if (value.directory === directory && !next.has(id)) {
            this.#values.delete(id);
            this.changed(value, undefined);
          }
        }
        for (const [id, value] of next) {
          const before = this.#values.get(id);
          this.#values.set(id, value);
          this.changed(before, value);
        }
        this.#known.add(directory);
        return true;
      },
      release: () => {
        this.#captures.delete(capture);
        capture.changes.clear();
      },
    };
  }
  reset(values: Iterable<PendingQuestion>, known: Iterable<string>): void {
    this.clear();
    for (const value of values) {
      this.#values.set(value.request.id, {
        ...value,
        generation: this.#generation,
      });
    }
    this.#known = new Set(known);
  }
  clear(): void {
    this.#generation++;
    this.#values.clear();
    this.#captures.clear();
    this.#known.clear();
  }
}
