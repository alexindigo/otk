// SPDX-License-Identifier: LGPL-3.0-only
import type {
  EntityState,
  ErrorObservation,
  IndexEntry,
  ServerFrame,
  SessionSettlement,
  TerminalEvidence,
  TerminalOutcome,
} from "@otk/protocol";
import { latestTerminal } from "@otk/protocol";
import { sessionTitle } from "./session-title.ts";
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
  decodeIndexObservation,
  type IndexChanges,
  sessionKey,
} from "./index.ts";
import type { EntryChanges } from "./entry-observations.ts";
import type { Note } from "./notifications.ts";
type IndexFrame = Extract<ServerFrame, { t: "index.snapshot" | "index.patch" }>;
interface Facts {
  working: boolean;
  permissions: number;
  permissionIDs: readonly string[];
  questions: number;
  questionIDs: readonly string[];
  errorIdentity: string;
  error?: string;
  observations?: ErrorObservation[];
  directory?: string;
  title: string;
  terminal?: number;
  runID?: string;
  outcome?: TerminalOutcome;
  unseen?: boolean;
  terminalOrigin?: TerminalEvidence["terminalOrigin"];
  terminalFailure?: TerminalEvidence["terminalFailure"];
}
function diagnosticFacts(
  entry: IndexEntry,
): Pick<Facts, "error" | "observations" | "errorIdentity"> {
  const { diagnostic } = decodeIndexObservation(entry);
  const errors = diagnostic["errorState"]?.observations.filter((item) =>
    !item.cleared
  );
  return {
    error: diagnostic.error,
    observations: errors,
    errorIdentity: JSON.stringify(errors ?? diagnostic.error ?? ""),
  };
}
const facts = (entry?: IndexEntry): Facts | undefined => {
  if (!entry || entry.deleted || entry.archived) return;
  const { diagnostic, native, phase } = decodeIndexObservation(entry);
  return {
    working: phase !== "idle",
    permissions: diagnostic.permissions,
    permissionIDs: native?.permissions?.keys ?? [],
    questions: diagnostic.questions,
    questionIDs: native?.inputs?.keys ?? [],
    ...diagnosticFacts(entry),
    directory: entry.directory,
    title: entry.title,
    terminal: native?.terminal,
    outcome: native?.outcome,
    terminalOrigin: native?.terminalOrigin,
    terminalFailure: native?.terminalFailure,
  };
};
function publishedFacts(
  entry: IndexEntry | undefined,
  entity: EntityState | null,
): Facts | undefined {
  if (!entry || entry.deleted || entry.archived) return;
  const evidence = entity?.evidence;
  return {
    title: entry.title,
    directory: entry.directory,
    working: evidence?.work === true,
    permissions: evidence?.permissions ?? 0,
    permissionIDs: evidence?.requests?.permissions.map(({ id }) => id) ?? [],
    questions: evidence?.questions ?? 0,
    questionIDs: evidence?.requests?.questions.map(({ id }) => id) ?? [],
    ...diagnosticFacts(entry),
    terminal: entity?.terminal,
    runID: entity?.runID,
    terminalOrigin: entity?.terminalOrigin,
    outcome: entity?.outcome,
    unseen: entity ? entity.counts.unseen > 0 : undefined,
    terminalFailure: evidence?.failure,
  };
}
/** Root comparison facts only; application delivery borrows accepted projected deltas. */
export class NotificationTriggers {
  #connections = new Map<
    string,
    {
      rev: number;
      generation?: string;
      roots: Map<string, Facts>;
      finishes: Map<string, TerminalEvidence>;
      settled: Map<string, number>;
      pendingSettlement: Map<string, SessionSettlement>;
    }
  >();
  #kinds = new Map<string, Note["kind"]>();
  #held = new Map<string, {
    note: Note;
    requests: readonly string[];
    presented?: { request: string; note: Note };
  }>();
  #delivered = new Map<string, Set<string>>();
  #outcomes = new Map<string, Note>();
  #flush(): void {
    for (const [id, held] of this.#held) {
      const delivered = this.#delivered.get(id) ?? new Set<string>();
      const eligible = held.requests;
      const fresh = eligible.filter((request) => !delivered.has(request));
      if (
        !fresh.length && held.presented &&
        eligible.includes(held.presented.request)
      ) continue;
      const requests = fresh.length ? fresh : eligible.slice(0, 1);
      if (!requests.length && held.presented) {
        held.presented = undefined;
        this.retract(id);
      }
      for (const request of requests) {
        const previous = held.presented?.note;
        const note = { ...held.note, dismissalKey: `permission/${request}` };
        const repeated = delivered.has(request);
        delivered.add(request);
        this.#delivered.set(id, delivered);
        held.presented = { request, note };
        this.emit(note, repeated ? previous ?? note : undefined);
      }
    }
  }
  #input(note: Note, requests: readonly string[]): void {
    if (note.kind !== "permission" || !requests.length) {
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
  ) {}
  stop(): void {
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
    const replaced = !state || state.generation !== change.generation;
    const baseline = replaced || change.baseline;
    if (!state || replaced) {
      if (state) {
        for (const session of state.settled.keys()) {
          this.settlement(sidecar, session, null);
        }
      }
      state = {
        rev: change.revision,
        generation: change.generation,
        roots: new Map(),
        finishes: new Map(),
        settled: new Map(),
        pendingSettlement: new Map(),
      };
      this.#connections.set(sidecar, state);
    } else if (change.revision <= state.rev) return;
    state.rev = change.revision;
    for (const entry of change.changes) {
      if (entry.entity !== undefined) {
        const value = publishedFacts(entry.after, entry.entity);
        this.#compare(
          sidecar,
          entry.id,
          value,
          baseline || entry.admitted === true,
          value?.terminalOrigin === "live" ? value.terminal : undefined,
          !replaced,
        );
        const pending = state.pendingSettlement.get(entry.id);
        if (pending && value) this.settlement(sidecar, entry.id, pending);
        else if (!value) state.pendingSettlement.delete(entry.id);
        continue;
      }
      const current = facts(entry.after);
      this.#compare(
        sidecar,
        entry.id,
        current,
        baseline,
        current?.terminalOrigin === "live" || baseline
          ? current?.terminal
          : undefined,
        !replaced,
      );
      const pending = state.pendingSettlement.get(entry.id);
      if (pending && current) this.settlement(sidecar, entry.id, pending);
      else if (!current && (entry.before || entry.after)) {
        state.pendingSettlement.delete(entry.id);
      }
    }
    if (!baseline) {
      for (const { sessionID, value } of change.settlements ?? []) {
        this.settlement(sidecar, sessionID, value);
      }
    }
  }

  settlement(
    sidecar: string,
    session: string,
    value: SessionSettlement | null,
  ): void {
    const connection = this.#connections.get(sidecar);
    if (!connection) return;
    const id = sessionKey(sidecar, session), previous = this.#outcomes.get(id);
    if (!value || !value.unseen || value.outcome !== "succeeded") {
      connection.pendingSettlement.delete(session);
      if (previous?.kind === "done") {
        this.#outcomes.delete(id);
        this.retract(previous.id);
      }
      return;
    }
    if (!value.live || value.id <= (connection.settled.get(session) ?? 0)) {
      return;
    }
    const entry = connection.roots.get(session);
    if (!entry) {
      const pending = connection.pendingSettlement.get(session);
      if (!pending || value.id >= pending.id) {
        connection.pendingSettlement.set(session, value);
      }
      return;
    }
    connection.pendingSettlement.delete(session);
    connection.settled.set(session, value.id);
    const note: Note = {
      id,
      kind: "done",
      sessionRef: { sidecar, session },
      title: "Session done",
      body: sessionTitle(session, entry.title),
      actions: [{
        label: "Open",
        command: "session.open",
        args: { sidecarId: sidecar, sessionID: session },
        default: true,
      }],
    };
    if (previous && previous.id !== id) this.retract(previous.id);
    this.#outcomes.set(id, note);
    this.emit(note);
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
        settled: new Map(),
        pendingSettlement: new Map(),
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
        decodeIndexObservation(entry).native?.terminal,
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
    connected = false,
  ): void {
    const state = this.#connections.get(sidecar)!;
    const previous = state.roots.get(session),
      id = sessionKey(sidecar, session);
    const old = previous ??
      {
        working: false,
        permissions: 0,
        permissionIDs: [],
        questions: 0,
        questionIDs: [],
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
    const historical = entry.terminalOrigin === "historical";
    const sameLiveTerminal = !historical && completedAt !== undefined &&
      completedAt === priorFinish?.terminal &&
      priorFinish?.terminalOrigin === "live";
    const finished = !historical && completedAt !== undefined &&
      completedAt > 0 &&
      (completedAt > (priorFinish?.terminal ?? 0) ||
        completedAt === priorFinish?.terminal &&
          (outcome !== undefined && outcome !== priorFinish.outcome ||
            entry.terminalOrigin === "live" &&
              priorFinish.terminalOrigin !== "live"));
    if (completedAt && (baseline || !entry.working)) {
      state.finishes.set(
        session,
        latestTerminal(priorFinish, {
          terminal: completedAt,
          outcome,
          // Baselines consume their known edge. Later history cannot consume a
          // not-yet-observed live edge or make an observed one fresh again.
          terminalOrigin: baseline ||
              completedAt === priorFinish?.terminal &&
                priorFinish.terminalOrigin === "live"
            ? "live"
            : entry.terminalOrigin,
        }),
      );
    }
    const acknowledged = !!entry.terminal && (entry.unseen === false ||
      old.unseen === false && old.terminal === entry.terminal &&
        old.runID === entry.runID);
    if (acknowledged) entry.unseen = false;
    if (acknowledged) {
      const note = this.#outcomes.get(id);
      if (note && note.kind !== "done") {
        this.#outcomes.delete(id);
        this.retract(note.id);
      }
    }
    if (baseline) {
      // A scope snapshot can be the first accepted frame to carry a live input
      // edge for a known session. It is not a reconnect or a historical admission.
      if (connected && previous) {
        this.#compareInput(
          sidecar,
          session,
          id,
          entry,
          old,
          this.#resolveInput(id, entry),
        );
      }
      return;
    }
    if (
      !previous && !finished && !entry.permissions && !entry.questions &&
      !entry.error
    ) return;
    const priorOutcome = this.#outcomes.get(id);
    if (
      !old.working && entry.working && priorOutcome &&
      priorOutcome.kind !== "done"
    ) {
      this.#outcomes.delete(id);
      this.retract(priorOutcome.id);
    }
    const remaining = this.#resolveInput(id, entry);
    const publishOutcome = (note: Note) => {
      const previous = this.#outcomes.get(id);
      const beforeCause = previous &&
        notificationFailure(previous)?.value.diagnosticID;
      const cause = notificationFailure(note)?.value.diagnosticID;
      const distinct = !historical && !sameLiveTerminal &&
        (beforeCause && cause && beforeCause !== cause &&
            (!!old.observations?.length || !!old.terminalFailure) ||
          priorFinish?.terminal !== undefined && completedAt !== undefined &&
            completedAt > priorFinish.terminal);
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
    const failed = !acknowledged &&
      (!historical || this.#outcomes.has(id)) &&
      (entry.error || entry.terminalFailure ||
        finished && outcome === "failed") &&
      (entry.errorIdentity !== old.errorIdentity ||
        JSON.stringify(entry.terminalFailure) !==
          JSON.stringify(old.terminalFailure) ||
        finished && outcome === "failed");
    if (failed) {
      const terminalObservation: ErrorObservation | undefined =
        entry.terminalFailure && {
          id: entry.terminalFailure.diagnosticID,
          source: "event",
          message: entry.terminalFailure.facts?.reason ?? "",
          failure: entry.terminalFailure,
        };
      const failures = (entry.observations?.length
        ? entry.observations
        : [terminalObservation])
        .map((observation) =>
          sessionFailure(
            observation,
            entry.error ?? (outcome === "failed"
              ? "The provider reported a failed execution without a reason."
              : undefined),
            {
              actionLabel: "Running session",
              recovery:
                "Open the session to inspect the provider response before sending a new prompt.",
              target: {
                sidecarId: sidecar,
                sessionID: session,
                directory: entry.directory,
                label: entry.title,
              },
            },
          )
        ).filter((value) =>
          value !== undefined
        );
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
    if (failure) {
      const retained = this.#outcomes.get(id);
      // Preserve the receipt for a live terminal upgrade. The hub replaces
      // it quietly only if still current; an independent failure has its ID.
      publishOutcome({
        ...failure,
        id: sameLiveTerminal && retained ? retained.id : `${id}/outcome/failed`,
      });
    } else if (
      !acknowledged && finished && outcome !== "failed" &&
      outcome !== "succeeded" &&
      !entry.working &&
      !entry.permissions &&
      !entry.questions
    ) {
      // A terminal arriving after its facts must not replace those facts with
      // generic copy when its terminal outcome is still unknown.
      const retained = this.#outcomes.get(id);
      if (
        !(retained?.kind === "error" && outcome === undefined &&
          (priorFinish?.terminal === undefined || sameLiveTerminal))
      ) {
        publishOutcome({
          // Failures always use structured action/target/cause/recovery above.
          id,
          kind: "info",
          sessionRef: { sidecar, session },
          title: outcome === "interrupted"
            ? "Session interrupted"
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
    this.#compareInput(sidecar, session, id, entry, old, remaining);
  }
  #resolveInput(
    id: string,
    entry: Facts,
  ): "permission" | "question" | undefined {
    const pending = this.#kinds.get(id);
    const resolved = (pending === "permission" && !entry.permissions) ||
      (pending === "question" && !entry.questions);
    if (!resolved) return undefined;
    if (entry.permissions) return "permission";
    if (entry.questions) return "question";
    // Retire the old input before its root ID can acquire a completion owner.
    this.#kinds.delete(id);
    this.#retractInput(id);
  }
  #compareInput(
    sidecar: string,
    session: string,
    id: string,
    entry: Facts,
    old: Pick<
      Facts,
      "permissions" | "permissionIDs" | "questions" | "questionIDs"
    >,
    remaining?: "permission" | "question",
  ): void {
    const newQuestion = entry.questionIDs.find((id) =>
      !old.questionIDs.includes(id)
    );
    const newPermission = entry.permissions > old.permissions ||
      entry.permissions > 0 &&
        entry.permissionIDs.some((id) => !old.permissionIDs.includes(id));
    const kind: Note["kind"] | undefined =
      entry.questions > 0 && (newQuestion || entry.questions > old.questions)
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
          ...(kind === "question" && (newQuestion ?? entry.questionIDs[0])
            ? {
              dismissalKey: `question/${newQuestion ?? entry.questionIDs[0]}`,
            }
            : {}),
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
