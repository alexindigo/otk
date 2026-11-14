// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ErrorObservation,
  IndexEntry,
  ServerFrame,
  TerminalEvidence,
  TerminalOutcome,
} from "@otk/protocol";
import { latestTerminal } from "@otk/protocol";
import { sessionTitle } from "./session-title.ts";
import { failureNote, sessionFailure } from "./failure-features.ts";
import { RequestFailure } from "./failures.ts";
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
  observations?: ErrorObservation[];
  directory?: string;
  title: string;
  terminal?: number;
  outcome?: TerminalOutcome;
}
const facts = (entry?: IndexEntry): Facts | undefined =>
  !entry || entry.deleted || entry.archived ? undefined : {
    status: entry.status,
    permissions: entry.attention.permissions,
    questions: entry.attention.questions,
    error: entry.attention.error,
    observations: entry.attention.errorState?.observations.filter((item) =>
      !item.cleared
    ),
    directory: entry.directory,
    errorIdentity: JSON.stringify(
      entry.attention.errorState?.observations.filter((o) => !o.cleared) ??
        entry.attention.error ?? "",
    ),
    title: entry.title,
    terminal: entry.activity?.terminal,
    outcome: entry.activity?.outcome,
  };
/** Root comparison facts only; application delivery borrows accepted projected deltas. */
export class NotificationTriggers {
  #connections = new Map<
    string,
    {
      rev: number;
      generation?: string;
      roots: Map<string, Facts>;
      finishes: Map<string, TerminalEvidence>;
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
      if (current && entry.completedAt && entry.completedOutcome) {
        current.terminal = entry.completedAt;
        current.outcome = entry.completedOutcome;
      }
      if (entry.after && !current && entry.completedAt) {
        state.finishes.set(entry.id, {
          terminal: entry.completedAt,
          outcome: entry.completedOutcome,
        });
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
    const outcome = completedAt === entry.terminal ? entry.outcome : undefined;
    const priorFinish = state.finishes.get(session);
    const finished = completedAt !== undefined && completedAt > 0 &&
      (completedAt > (priorFinish?.terminal ?? 0) ||
        completedAt === priorFinish?.terminal && outcome !== undefined &&
          outcome !== priorFinish.outcome);
    if (completedAt && (baseline || entry.status === "idle")) {
      state.finishes.set(
        session,
        latestTerminal(priorFinish, { terminal: completedAt, outcome }),
      );
    }
    if (
      baseline ||
      !previous && !finished && !entry.permissions && !entry.questions &&
        !entry.error
    ) return;
    if (entry.error && entry.errorIdentity !== old.errorIdentity) {
      for (
        const observation of entry.observations?.length
          ? entry.observations
          : [undefined]
      ) {
        const failure = sessionFailure(observation, entry.error, {
          action: "Running session",
          target: {
            sidecarId: sidecar,
            sessionID: session,
            directory: entry.directory,
            label: entry.title,
          },
        });
        const note = failure && failureNote(new RequestFailure(failure));
        if (note) this.emit(note);
      }
    }
    const pending = this.#kinds.get(id);
    const resolved = (pending === "permission" && !entry.permissions) ||
      (pending === "question" && !entry.questions) ||
      (["done", "error", "info"].includes(pending ?? "") &&
        entry.status !== "idle");
    const remaining = resolved
      ? entry.permissions
        ? "permission"
        : entry.questions
        ? "question"
        : undefined
      : undefined;
    const kind: Note["kind"] | undefined = entry.permissions > old.permissions
      ? "permission"
      : entry.questions > old.questions
      ? "question"
      : finished &&
          entry.status === "idle" &&
          !entry.permissions && !entry.questions
      ? outcome === "succeeded"
        ? "done"
        : outcome === "failed"
        ? "error"
        : "info"
      : remaining;
    if (kind) {
      this.#kinds.set(id, kind);
      this.emit({
        id,
        kind,
        sessionRef: { sidecar, session },
        title: finished && !["permission", "question"].includes(kind)
          ? outcome === "failed"
            ? "Session failed"
            : outcome === "interrupted"
            ? "Session interrupted"
            : outcome === "succeeded"
            ? "Session done"
            : "Session finished (outcome unknown)"
          : ({
            done: "Session done",
            permission: "Permission needed",
            question: "Question needs input",
            error: "Session error",
            info: "Information",
          })[kind],
        body: sessionTitle(session, entry.title),
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
