// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, ServerFrame } from "@otk/protocol";
import {
  acceptsPatch,
  type ClientIndex,
  createIndex,
  type IndexChanges,
  sessionKey,
} from "./index.ts";
import type { EntryChanges } from "./approval-attention.ts";
import type { Note } from "./notifications.ts";
type IndexFrame = Extract<ServerFrame, { t: "index.snapshot" | "index.patch" }>;
interface Facts {
  status: IndexEntry["status"];
  permissions: number;
  questions: number;
  errorIdentity: string;
  error?: string;
  title: string;
}
const facts = (entry?: IndexEntry): Facts | undefined =>
  !entry || entry.deleted || entry.archived ? undefined : {
    status: entry.status,
    permissions: entry.attention.permissions,
    questions: entry.attention.questions,
    error: entry.attention.error,
    errorIdentity: JSON.stringify(
      entry.attention.errorState?.observations.filter((o) => !o.cleared) ??
        entry.attention.error ?? "",
    ),
    title: entry.title,
  };
/** Root comparison facts only; application delivery borrows accepted projected deltas. */
export class NotificationTriggers {
  #connections = new Map<
    string,
    {
      rev: number;
      generation?: string;
      roots: Map<string, Facts>;
      finishes: Map<string, number>;
    }
  >();
  #kinds = new Map<string, Note["kind"]>();
  #index?: ClientIndex;
  constructor(
    readonly emit: (note: Note) => void,
    readonly retract: (id: string) => void,
    readonly project: (sidecar: string, entries: IndexEntry[]) => IndexEntry[] =
      (_sidecar, entries) => entries,
    readonly read?: (sidecar: string) => readonly IndexEntry[],
    readonly changes?: (sidecar: string) => IndexChanges | undefined,
  ) {}
  reset(sidecar: string): void {
    this.#index?.remove(sidecar);
    this.#connections.delete(sidecar);
    for (const key of [...this.#kinds.keys()]) {
      if (key.startsWith(sidecar + "/")) {
        this.#kinds.delete(key);
        this.retract(key);
      }
    }
  }
  /** Accepts immutable borrowed values for this turn; retains no IndexEntry. */
  entriesChanged(sidecar: string, change: EntryChanges): void {
    let state = this.#connections.get(sidecar);
    const baseline = !state ||
      state.generation !== change.generation;
    if (!state || baseline) {
      state = {
        rev: change.revision,
        generation: change.generation,
        roots: new Map(),
        finishes: new Map(),
      };
      this.#connections.set(sidecar, state);
    } else if (change.revision <= state.rev) return;
    state.rev = change.revision;
    for (const entry of change.changes) {
      const current = facts(entry.after);
      if (entry.after && !current && entry.completedAt) {
        state.finishes.set(entry.id, entry.completedAt);
      }
      this.#compare(
        sidecar,
        entry.id,
        current,
        baseline,
        entry.completedAt,
      );
    }
  }
  // Standalone frame consumers borrow the ordinary canonical reducer as before.
  // Shipped consumers use entriesChanged and never call this compatibility path.
  receive(sidecar: string, frame: IndexFrame): boolean {
    const state = this.#connections.get(sidecar);
    if (this.read) {
      if (!acceptsPatch(state?.rev, frame)) return false;
    } else if (!(this.#index ??= createIndex()).receive(sidecar, frame)) {
      return false;
    }
    const changed = this.read
      ? this.changes?.(sidecar)
      : this.#index?.changes(sidecar);
    if (state && changed?.revision === frame.rev && !changed.metadata.length) {
      state.rev = frame.rev;
      return true;
    }
    this.#refresh(sidecar, frame.rev);
    return true;
  }
  refresh(sidecar: string): void {
    const state = this.#connections.get(sidecar);
    if (state) this.#refresh(sidecar, state.rev);
  }
  #refresh(sidecar: string, rev: number): void {
    const previous = this.#connections.get(sidecar);
    if (!previous) {
      this.#connections.set(sidecar, {
        rev,
        roots: new Map(),
        finishes: new Map(),
      });
    }
    const rows = this.project(sidecar, [
      ...(this.read?.(sidecar) ?? this.#index?.partition(sidecar) ?? []),
    ]);
    const pending = new Set(previous?.roots.keys());
    for (const entry of rows) {
      pending.delete(entry.id);
      this.#compare(
        sidecar,
        entry.id,
        facts(entry),
        !previous,
        entry.activity?.terminal,
      );
    }
    for (const id of pending) this.#compare(sidecar, id, undefined, false);
    this.#connections.get(sidecar)!.rev = rev;
  }
  #compare(
    sidecar: string,
    session: string,
    entry: Facts | undefined,
    baseline: boolean,
    completedAt?: number,
  ): void {
    const state = this.#connections.get(sidecar)!;
    const previous = state.roots.get(session),
      id = sessionKey(sidecar, session);
    const old = previous ??
      {
        status: "idle",
        permissions: 0,
        questions: 0,
        errorIdentity: "",
        title: "",
      };
    if (entry) state.roots.set(session, entry);
    else state.roots.delete(session);
    if (!entry) {
      if (this.#kinds.delete(id)) this.retract(id);
      return;
    }
    const finished = completedAt !== undefined &&
      completedAt > (state.finishes.get(session) ?? 0);
    if (completedAt && (baseline || entry.status === "idle")) {
      state.finishes.set(session, completedAt);
    }
    if (
      baseline ||
      !previous && !finished && !entry.permissions && !entry.questions
    ) return;
    const pending = this.#kinds.get(id);
    const resolved = (pending === "permission" && !entry.permissions) ||
      (pending === "question" && !entry.questions) ||
      (pending === "error" && !entry.error) ||
      (pending === "done" && entry.status !== "idle");
    const remaining = resolved
      ? entry.error
        ? "error"
        : entry.permissions
        ? "permission"
        : entry.questions
        ? "question"
        : undefined
      : undefined;
    const kind: Note["kind"] | undefined =
      entry.error && entry.errorIdentity !== old.errorIdentity
        ? "error"
        : entry.permissions > old.permissions
        ? "permission"
        : entry.questions > old.questions
        ? "question"
        : finished &&
            entry.status === "idle" && !entry.error &&
            !entry.permissions && !entry.questions
        ? "done"
        : remaining;
    if (kind) {
      this.#kinds.set(id, kind);
      this.emit({
        id,
        kind,
        sessionRef: { sidecar, session },
        title: ({
          done: "Session done",
          permission: "Permission needed",
          question: "Question needs input",
          error: "Session error",
          info: "Information",
        })[kind],
        body: kind === "error" ? `${entry.title}: ${entry.error}` : entry.title,
        actions: [{
          label: "Open",
          command: "session.open",
          args: { sidecarId: sidecar, sessionID: session },
          default: true,
        }],
      });
    } else if (resolved) {
      this.#kinds.delete(id);
      this.retract(id);
    }
  }
}
