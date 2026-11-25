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
import type { AttentionGrace } from "./attention-grace.ts";
import {
  failureNote,
  notificationFailure,
  sessionFailure,
} from "./failure-features.ts";
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
  permissionIDs: readonly string[];
  questions: number;
  errorIdentity: string;
  error?: string;
  observations?: ErrorObservation[];
  directory?: string;
  title: string;
  terminal?: number;
  outcome?: TerminalOutcome;
  unseen?: boolean;
}
const facts = (entry?: IndexEntry): Facts | undefined =>
  !entry || entry.deleted || entry.archived ? undefined : {
    status: entry.status,
    permissions: entry.attention.permissions,
    permissionIDs: entry.activity?.permissions?.keys ?? [],
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
  #held = new Map<string, {
    note: Note;
    requests: readonly string[];
    presented?: { request: string; note: Note };
  }>();
  #delivered = new Map<string, Set<string>>();
  #releaseGrace?: () => void;
  #outcomes = new Map<string, Note>();
  #flush(): void {
    for (const [id, held] of this.#held) {
      const server = held.note.sessionRef!.sidecar;
      const delivered = this.#delivered.get(id) ?? new Set<string>();
      const eligible = held.requests.filter((request) =>
        this.grace!.eligible(server, request)
      );
      const fresh = eligible.find((request) => !delivered.has(request));
      if (
        !fresh && held.presented && eligible.includes(held.presented.request)
      ) {
        continue;
      }
      const request = fresh ?? eligible[0];
      if (!request) {
        if (held.presented) {
          held.presented = undefined;
          this.retract(id);
        }
        continue;
      }
      const previous = held.presented?.note;
      const note = {
        ...held.note,
        dismissalKey: `permission/${request}`,
      };
      const repeated = delivered.has(request);
      delivered.add(request);
      this.#delivered.set(id, delivered);
      held.presented = { request, note };
      this.emit(note, repeated ? previous ?? note : undefined);
    }
  }
  #input(note: Note, requests: readonly string[]): void {
    if (note.kind !== "permission" || !this.grace) {
      this.#held.delete(note.id);
      this.emit(note);
      return;
    }
    this.#held.set(note.id, {
      note,
      requests,
      presented: this.#held.get(note.id)?.presented,
    });
    this.#flush();
  }
  #retractInput(id: string): void {
    this.#held.delete(id);
    this.#delivered.delete(id);
    this.retract(id);
  }
  #index?: ClientIndex;
  constructor(
    /** previous identifies a same-outcome enrichment, never another fresh alert. */
    readonly emit: (note: Note, previous?: Note) => void,
    readonly retract: (id: string) => void,
    readonly project: (sidecar: string, entries: IndexEntry[]) => IndexEntry[] =
      (_sidecar, entries) => entries,
    readonly read?: (sidecar: string) => readonly IndexEntry[],
    readonly changes?: (sidecar: string) => IndexChanges | undefined,
    readonly grace?: AttentionGrace,
  ) {
    this.#releaseGrace = grace?.subscribe(() => this.#flush());
  }
  stop(): void {
    this.#releaseGrace?.();
    this.#releaseGrace = undefined;
    for (const sidecar of [...this.#connections.keys()]) this.reset(sidecar);
  }
  reset(sidecar: string): void {
    this.#index?.remove(sidecar);
    this.#connections.delete(sidecar);
    for (const key of [...this.#kinds.keys()]) {
      if (key.startsWith(sidecar + "/")) {
        this.#kinds.delete(key);
        this.#retractInput(key);
      }
    }
    for (const [key, note] of this.#outcomes) {
      if (key.startsWith(sidecar + "/")) {
        this.#outcomes.delete(key);
        this.retract(note.id);
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
      if (current) current.unseen = entry.completedUnseen;
      if (current && entry.completedAt) {
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
    // Install current routing/settlement facts before grace publication can
    // synchronously release a notification through an injected state factory.
    for (const entry of change.changes) {
      if (entry.after) {
        this.grace?.observe(sidecar, entry.id, entry.after.activity);
      }
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
    for (const entry of rows) {
      this.grace?.observe(sidecar, entry.id, entry.activity);
    }
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
        permissionIDs: [],
        questions: 0,
        errorIdentity: "",
        title: "",
      };
    if (entry) state.roots.set(session, entry);
    else state.roots.delete(session);
    if (!entry) {
      if (this.#kinds.delete(id)) this.#retractInput(id);
      const outcome = this.#outcomes.get(id);
      if (outcome) {
        this.#outcomes.delete(id);
        this.retract(outcome.id);
      }
      return;
    }
    const outcome = completedAt === entry.terminal ? entry.outcome : undefined;
    const priorFinish = state.finishes.get(session);
    const finished = completedAt !== undefined && completedAt > 0 &&
      (completedAt > (priorFinish?.terminal ?? 0) ||
        completedAt === priorFinish?.terminal && outcome !== undefined &&
          outcome !== priorFinish.outcome ||
        entry.unseen === true && old.unseen === false);
    if (completedAt && (baseline || entry.status === "idle")) {
      state.finishes.set(
        session,
        latestTerminal(priorFinish, { terminal: completedAt, outcome }),
      );
    }
    const acknowledged = !!entry.terminal && entry.unseen === false;
    if (acknowledged) {
      const note = this.#outcomes.get(id);
      if (note) {
        this.#outcomes.delete(id);
        this.retract(note.id);
      }
    }
    if (
      baseline ||
      !previous && !finished && !entry.permissions && !entry.questions &&
        !entry.error
    ) return;
    const priorOutcome = this.#outcomes.get(id);
    if (old.status === "idle" && entry.status !== "idle" && priorOutcome) {
      this.#outcomes.delete(id);
      this.retract(priorOutcome.id);
    }
    const pending = this.#kinds.get(id);
    const resolved = (pending === "permission" && !entry.permissions) ||
      (pending === "question" && !entry.questions);
    const remaining = resolved
      ? entry.permissions
        ? "permission"
        : entry.questions
        ? "question"
        : undefined
      : undefined;
    // Retire the old input before its root ID can acquire a completion owner.
    if (resolved && !remaining) {
      this.#kinds.delete(id);
      this.#retractInput(id);
    }
    const publishOutcome = (note: Note) => {
      const previous = this.#outcomes.get(id);
      const beforeCause = previous &&
        notificationFailure(previous)?.value.diagnosticID;
      const cause = notificationFailure(note)?.value.diagnosticID;
      const distinct = beforeCause && cause && beforeCause !== cause ||
        priorFinish?.terminal !== undefined && completedAt !== undefined &&
          completedAt > priorFinish.terminal;
      if (
        !distinct && previous &&
        JSON.stringify(previous) === JSON.stringify(note)
      ) return;
      if (previous && previous.id !== note.id) this.retract(previous.id);
      this.#outcomes.set(id, note);
      this.emit(
        note,
        previous?.id === note.id && !distinct ? previous : undefined,
      );
    };
    // Failure facts and failed completion are updates to the same session
    // outcome, not independent notification producers. This also enriches a
    // terminal-only note when its facts arrive later.
    let failure: Note | undefined;
    const failed = !acknowledged && entry.error &&
      (entry.errorIdentity !== old.errorIdentity ||
        finished && outcome === "failed");
    if (failed) {
      const failures =
        (entry.observations?.length ? entry.observations : [undefined])
          .map((observation) =>
            sessionFailure(observation, entry.error, {
              actionLabel: "Running session",
              target: {
                sidecarId: sidecar,
                sessionID: session,
                directory: entry.directory,
                label: entry.title,
              },
            })
          ).filter((value) => value !== undefined);
      const latest = failures.at(-1);
      if (latest) {
        failure = failureNote(
          new RequestFailure({
            ...latest,
            facts: {
              ...latest.facts,
              reason: [
                ...new Set(
                  failures.map((value) => value.facts?.reason).filter(Boolean),
                ),
              ].join("\n"),
            },
          }),
        );
      }
    }
    if (failure) publishOutcome({ ...failure, id: `${id}/outcome/failed` });
    else if (
      !acknowledged && finished && entry.status === "idle" &&
      !entry.permissions &&
      !entry.questions
    ) {
      // A terminal arriving after its facts must not replace those facts with
      // generic copy. Failed/unknown completion enriches the same outcome.
      const retained = this.#outcomes.get(id);
      if (
        !(retained?.id === `${id}/outcome/failed` &&
          (outcome === "failed" || outcome === undefined))
      ) {
        publishOutcome({
          // Preserve existing successful/unknown completion identities. Only
          // failed completion joins the independent failure-facts outcome key.
          id: outcome === "failed" ? `${id}/outcome/failed` : id,
          kind: outcome === "failed"
            ? "error"
            : outcome === "succeeded"
            ? "done"
            : "info",
          sessionRef: { sidecar, session },
          title: outcome === "failed"
            ? "Session failed"
            : outcome === "interrupted"
            ? "Session interrupted"
            : outcome === "succeeded"
            ? "Session done"
            : "Session finished (outcome unknown)",
          body: sessionTitle(session, entry.title),
          actions: [{
            label: "Open",
            command: "session.open",
            args: { sidecarId: sidecar, sessionID: session },
            default: true,
          }],
        });
      }
    }
    const newPermission = entry.permissions > old.permissions ||
      entry.permissions > 0 &&
        entry.permissionIDs.some((id) => !old.permissionIDs.includes(id));
    const kind: Note["kind"] | undefined = entry.questions > old.questions
      ? "question"
      : newPermission || this.#held.has(id) && entry.permissions > 0
      ? "permission"
      : remaining;
    if (kind) {
      // Ordinary completion and input attention historically replace one root
      // note. Do not retain a stale alias that could later retract its input.
      if (this.#outcomes.get(id)?.id === id) this.#outcomes.delete(id);
      this.#kinds.set(id, kind);
      this.#input(
        {
          id,
          kind,
          sessionRef: { sidecar, session },
          title: kind === "permission"
            ? "Permission needed"
            : "Question needs input",
          body: sessionTitle(session, entry.title),
          actions: [{
            label: "Open",
            command: "session.open",
            args: { sidecarId: sidecar, sessionID: session },
            default: true,
          }],
        },
        entry.permissionIDs,
      );
    }
  }
}
