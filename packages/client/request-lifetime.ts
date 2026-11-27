// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type ContentOp,
  type FormRequest,
  type InputPhase,
  inputTransition,
  type PermissionRequest,
  type QuestionRequest,
  type SessionLookup,
} from "@otk/protocol";
import { type EntryChanges, permissionRouting } from "./entry-observations.ts";

export type RequestKind = "permission" | "question" | "form";
export interface RequestLifetime extends InputPhase {
  id: string;
  kind: "permission" | "input";
  sessionID?: string;
  reason?: string;
  permission?: PermissionRequest;
  question?: QuestionRequest;
  form?: FormRequest;
  draft?: unknown;
  scopes?: Set<string>;
  /** Client-local receipt clock of this identity; never a server timestamp. */
  arrivedAt?: number;
}
const key = (kind: RequestKind, id: string) =>
  `${kind === "permission" ? "permission" : "input"}:${id}`;
type PermissionOp = Extract<ContentOp, {
  op: "permission.upsert" | "permission.remove";
}>;
type PermissionRead = {
  controller: AbortController;
  events: Map<string, PermissionOp>;
  entry: SessionLookup;
  budget?: { replayops: number; replaybytes: number };
  count: number;
  bytes: number;
  result: Promise<PermissionRequest[]>;
  users: number;
};
/** One identity owns authority, local presentation and retained input. Views only project it. */
export class RequestLifetimes {
  #records = new Map<string, RequestLifetime>();
  #consumed = new WeakSet<RequestLifetime>();
  #listeners = new Set<() => void>();
  #revision = 0;
  #batch = 0;
  #dirty = false;
  #deleted: (id: string) => boolean = () => false;
  #permissionReads = new Map<string, PermissionRead>();
  #permissionScopes = new Map<
    string,
    { ids: Set<string>; entry: SessionLookup }
  >();
  constructor(
    readonly now: () => number = () => performance.now(),
    readonly retireDisclosures?: (scope: string) => void,
  ) {}
  snapshot(): unknown {
    return [...this.#records].filter(([, row]) =>
      row.draft !== undefined || row.dismissed
    );
  }
  restore(value: unknown): void {
    for (const [key, row] of value as [string, RequestLifetime][]) {
      // Saved input is custody, not fresh server authority or a new arrival.
      this.#records.set(key, { ...row, arrivedAt: undefined });
    }
    this.#changed();
  }
  /** When a permission identity first arrived here (per-request grace). */
  arrival(id: string): number | undefined {
    return this.get("permission", id)?.arrivedAt;
  }
  get revision(): number {
    return this.#revision;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed(): void {
    if (this.#batch) {
      this.#dirty = true;
      return;
    }
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }
  #atomic(run: () => void): void {
    this.#batch++;
    try {
      run();
    } finally {
      if (--this.#batch === 0 && this.#dirty) {
        this.#dirty = false;
        this.#changed();
      }
    }
  }
  get(kind: RequestKind, id: string): RequestLifetime | undefined {
    return this.#records.get(key(kind, id));
  }
  /** Transcript and background delivery lease the same scoped inventory. */
  readPermissions(
    scope: string,
    entry: SessionLookup,
    load: (signal: AbortSignal) => Promise<PermissionRequest[]>,
    budget: PermissionRead["budget"],
    signal?: AbortSignal,
  ): Promise<PermissionRequest[]> {
    signal?.throwIfAborted();
    if (this.#permissionScopes.has(scope)) {
      return Promise.resolve(this.permissions(scope, entry));
    }
    let current = this.#permissionReads.get(scope);
    if (!current) {
      const controller = new AbortController();
      const events = new Map<string, PermissionOp>();
      const loading = Promise.withResolvers<PermissionRequest[]>();
      const result = loading.promise.then((rows) => {
        controller.signal.throwIfAborted();
        const live = [...events.values()].filter((op) =>
          op.op === "permission.remove" ||
          belongsToSession(op.request.sessionID, scope, entry)
        );
        this.replace("permission", rows, scope, entry, live);
        const inventory = this.permissions(scope, entry);
        if (inventory.length) {
          this.#permissionScopes.set(scope, {
            ids: new Set(inventory.map((r) => r.id)),
            entry,
          });
        }
        return inventory;
      }).finally(() => {
        if (this.#permissionReads.get(scope) === current) {
          this.#permissionReads.delete(scope);
        }
      });
      current = {
        controller,
        events,
        entry,
        budget,
        count: 0,
        bytes: 0,
        result,
        users: 0,
      };
      this.#permissionReads.set(scope, current);
      try {
        loading.resolve(load(controller.signal));
      } catch (error) {
        loading.reject(error);
      }
    }
    const read = current;
    read.users++;
    let cancelled: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (cancelled) signal?.removeEventListener("abort", cancelled);
      if (--read.users === 0 && this.#permissionReads.get(scope) === read) {
        this.#permissionReads.delete(scope);
        read.controller.abort();
      }
    };
    return new Promise<PermissionRequest[]>((resolve, reject) => {
      if (signal) {
        cancelled = () => {
          release();
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancelled, { once: true });
      }
      void read.result.then(resolve, reject);
    }).finally(release);
  }
  /** New routing facts invalidate coverage before notification consumers run. */
  observePermissionScopes(change: EntryChanges, entry: SessionLookup): void {
    for (const { id, before, after } of change.changes) {
      const previous = permissionRouting(before);
      const current = permissionRouting(after);
      if (
        previous?.fresh === current?.fresh &&
        before?.parentID === after?.parentID &&
        before?.deleted === after?.deleted &&
        previous?.keys.length === current?.keys.length &&
        previous?.keys.every((key, i) => key === current?.keys[i]) !== false
      ) continue;
      for (const [scope, { ids }] of this.#permissionScopes) {
        if (
          current?.fresh && current.keys.some((key) => !ids.has(key)) &&
            belongsToSession(id, scope, entry) ||
          [...ids].some((key) => {
            const row = this.get("permission", key);
            return row?.sessionID === id &&
              (!current?.fresh || !current.keys.includes(key) ||
                !!after?.deleted || !belongsToSession(id, scope, entry));
          })
        ) this.#permissionScopes.delete(scope);
      }
    }
  }
  resetPermissionScopes(): void {
    this.#permissionScopes.clear();
    for (const read of this.#permissionReads.values()) read.controller.abort();
    this.#permissionReads.clear();
  }
  receive(op: ContentOp): void {
    if (op.op === "permission.upsert" || op.op === "permission.remove") {
      const id = op.op === "permission.upsert" ? op.request.id : op.requestID;
      for (const [scope, read] of this.#permissionReads) {
        if (
          op.op === "permission.upsert" &&
          !belongsToSession(op.request.sessionID, scope, read.entry)
        ) continue;
        read.bytes += JSON.stringify(op).length * 2;
        if (
          !read.budget || ++read.count > read.budget.replayops ||
          read.bytes > read.budget.replaybytes
        ) {
          this.#permissionReads.delete(scope);
          read.controller.abort();
        } else read.events.set(id, op);
      }
      if (op.op === "permission.upsert") {
        for (const [scope, { ids, entry }] of this.#permissionScopes) {
          if (
            !ids.has(id) && belongsToSession(op.request.sessionID, scope, entry)
          ) {
            this.#permissionScopes.delete(scope);
          }
        }
      }
      if (op.op === "permission.remove") this.#retirePermissionScopes(id);
    }
    this.#receive(op);
  }
  #retirePermissionScopes(id: string): void {
    for (const [scope, { ids }] of this.#permissionScopes) {
      if (ids.has(id)) this.#permissionScopes.delete(scope);
    }
  }
  #receive(op: ContentOp): void {
    const kind: RequestKind | undefined = op.op.startsWith("permission.")
      ? "permission"
      : op.op.startsWith("question.")
      ? "question"
      : op.op.startsWith("form.")
      ? "form"
      : undefined;
    if (!kind) return;
    if (
      op.op === "permission.remove" || op.op === "question.remove" ||
      op.op === "form.remove"
    ) {
      const row = this.get(kind, op.requestID);
      if (
        kind === "question" && row?.form && row.form.presentation !== "question"
      ) {
        row.question = undefined;
        this.#changed();
        return;
      }
      this.retire(kind, op.requestID, "settled-remotely", "native retirement");
      return;
    }
    if (
      op.op !== "permission.upsert" && op.op !== "question.upsert" &&
      op.op !== "form.upsert"
    ) return;
    const previous = this.get(kind, op.request.id);
    const { phase } = inputTransition(previous, { type: "observe" });
    if (!phase) return;
    // The typed inventory owns its presentation. A lagging question inventory
    // cannot recreate the removed compatibility projection of that same input.
    if (
      op.op === "question.upsert" && previous?.form &&
      previous.form.presentation !== "question"
    ) return;
    const row: RequestLifetime = previous ??
      {
        id: op.request.id,
        kind: kind === "permission" ? "permission" : "input",
        ...phase,
        arrivedAt: this.now(),
      };
    if (op.op === "permission.upsert") {
      row.permission = op.request;
      row.sessionID = op.request.sessionID;
    }
    if (op.op === "question.upsert") {
      row.question = op.request;
      row.sessionID = op.request.sessionID;
    }
    if (op.op === "form.upsert") {
      row.form = op.request;
      row.sessionID = op.request.owner.kind === "session"
        ? op.request.owner.sessionID
        : undefined;
      if (op.request.presentation !== "question") row.question = undefined;
      else if (row.sessionID) {
        row.question = {
          id: row.id,
          sessionID: row.sessionID,
          questions: op.request.fields.map((field) => ({
            header: field.title,
            text: field.description ?? field.title ?? field.key,
            options: field.type === "string" || field.type === "multiselect"
              ? field.options?.map((option) => ({
                label: option.label,
                description: option.description,
              })) ?? []
              : [],
            multiple: field.type === "multiselect",
            custom: (field.type === "string" || field.type === "multiselect") &&
              !!field.custom,
          })),
        };
      }
    }
    if (row.sessionID && this.#deleted(row.sessionID)) {
      Object.assign(
        row,
        inputTransition(row, { type: "settle", state: "retired" }).phase,
      );
      row.reason = "session deleted";
    }
    this.#records.set(key(kind, row.id), row);
    this.#changed();
  }
  retire(
    kind: RequestKind,
    id: string,
    state: "settled-remotely" | "retired",
    reason: string,
  ): void {
    this.#retire(kind, id, state, reason);
  }
  /** Capture before sending. Native retirement may win delivery order, but a
   * confirmed reply consumes only its submitted draft, never a newer one. */
  settlement(kind: RequestKind, id: string): () => void {
    const row = this.get(kind, id), draft = row?.draft;
    return () => {
      if (!row || this.get(kind, id) !== row) return;
      this.#atomic(() => {
        if (row.draft === draft) {
          row.draft = undefined;
          this.#consumed.add(row);
        }
        this.#retire(kind, id, "settled-locally", "local response confirmed");
        this.#changed();
      });
    };
  }
  #retire(
    kind: RequestKind,
    id: string,
    state: Exclude<RequestLifetime["state"], "pending">,
    reason: string,
  ): void {
    const previous = this.get(kind, id);
    const { phase } = inputTransition(previous, { type: "settle", state });
    if (!phase) return;
    const row: RequestLifetime = previous ??
      { id, kind: kind === "permission" ? "permission" : "input", ...phase };
    if (kind === "permission") this.#retirePermissionScopes(id);
    Object.assign(row, phase);
    row.reason = reason;
    this.#records.set(key(kind, id), row);
    if (row.kind === "permission") this.retireDisclosures?.(id);
    this.#changed();
  }
  dismiss(kind: RequestKind, id: string): void {
    this.#present(kind, id, "dismiss");
  }
  show(kind: RequestKind, id: string): void {
    this.#present(kind, id, "show");
  }
  #present(kind: RequestKind, id: string, type: "dismiss" | "show"): void {
    const row = this.get(kind, id);
    const { phase } = inputTransition(row, { type });
    if (row && phase) {
      Object.assign(row, phase);
      this.#changed();
    }
  }
  draft(kind: RequestKind, id: string, value?: unknown): unknown {
    const row = this.get(kind, id);
    if (
      row && arguments.length === 3 &&
      (value === undefined ||
        row.state !== "settled-locally" && !this.#consumed.has(row))
    ) row.draft = value;
    return row?.draft;
  }
  getFormDraft(id: string): import("./forms.ts").FormState | undefined {
    return this.draft("form", id) as import("./forms.ts").FormState | undefined;
  }
  saveFormDraft(id: string, value: import("./forms.ts").FormState): void {
    this.draft("form", id, value);
  }
  forgetFormDraft(id: string): void {
    this.draft("form", id, undefined);
  }
  /** Capture canonical unsent input even when retirement unmounted its view
   * before the session tombstone arrived. Consent consumes this exact scope. */
  retention(
    scope: string,
    entry: SessionLookup,
  ): import("./input-guard.ts").InputRetention {
    const rows = [...this.#records.values()].filter((row) =>
      this.#inScope(row, scope, entry) && row.draft !== undefined
    );
    const captured = rows.map((row) => ({ row, draft: row.draft }));
    const inputs = new Map<string, string[]>();
    for (const row of rows) {
      const form = typeof row.draft === "object" && row.draft !== null
        ? row.draft as import("./forms.ts").FormState
        : undefined;
      const value = typeof row.draft === "string" ? row.draft : form?.drafts &&
          Object.values(form.drafts).some((draft) => draft.touched)
        ? JSON.stringify(form.drafts)
        : "";
      if (!value) continue;
      const owner = row.permission
        ? "permissions"
        : row.question
        ? "questions"
        : "forms";
      const values = inputs.get(owner) ?? [];
      values.push(value);
      inputs.set(owner, values);
    }
    return {
      owners: ["permissions", "questions", "forms"],
      inputs: [...inputs].map(([owner, values]) => ({
        owner,
        value: values.join("\n"),
      })),
      discard: () => {
        for (const { row, draft } of captured) {
          if (row.draft === draft) row.draft = undefined;
        }
      },
    };
  }
  retireSessions(deleted: (id: string) => boolean): void {
    this.#deleted = deleted;
    let changed = false;
    for (const row of this.#records.values()) {
      if (row.state === "pending" && row.sessionID && deleted(row.sessionID)) {
        row.state = "retired";
        row.reason = "session deleted";
        if (row.kind === "permission") this.retireDisclosures?.(row.id);
        changed = true;
      }
    }
    if (changed) this.#changed();
  }
  replace(
    kind: RequestKind,
    rows: readonly (PermissionRequest | QuestionRequest | FormRequest)[],
    scope?: string,
    entry: SessionLookup = () => undefined,
    live: readonly ContentOp[] = [],
  ): void {
    this.#atomic(() => {
      const inventory = new Map(rows.map((row) => [row.id, row]));
      for (const op of live) {
        if (op.op === `${kind}.upsert` && "request" in op) {
          inventory.set(
            op.request.id,
            op.request as PermissionRequest | QuestionRequest | FormRequest,
          );
        } else if (op.op === `${kind}.remove` && "requestID" in op) {
          inventory.delete(op.requestID);
        }
      }
      rows = [...inventory.values()];
      const ids = new Set(rows.map((row) => row.id));
      for (const row of this.#records.values()) {
        const present = kind === "permission"
          ? row.permission
          : kind === "question"
          ? row.question
          : row.form;
        if (
          row.state === "pending" && present &&
          (!scope ||
            this.#inScope(row, scope, entry)) &&
          !ids.has(row.id)
        ) {
          this.retire(
            kind,
            row.id,
            "retired",
            "authoritative inventory absence",
          );
        }
      }
      for (const request of rows) {
        this.#receive({ op: `${kind}.upsert`, request } as ContentOp);
        const row = this.get(kind, request.id);
        if (scope && row) (row.scopes ??= new Set()).add(scope);
      }
      this.#changed();
    });
  }
  #inScope(row: RequestLifetime, scope: string, entry: SessionLookup): boolean {
    if (!row.sessionID) return false;
    if (belongsToSession(row.sessionID, scope, entry)) return true;
    if (!row.scopes?.has(scope)) return false;
    // A successful inventory bridges missing ancestry, not a later proven move.
    const seen = new Set<string>();
    let id: string | undefined = row.sessionID;
    while (id && !seen.has(id)) {
      seen.add(id);
      const known = entry(id);
      if (!known) return true;
      id = known.parentID;
    }
    return false;
  }
  #pending(
    scope?: string,
    entry: SessionLookup = () => undefined,
    presentation = false,
  ): RequestLifetime[] {
    return [...this.#records.values()].filter((row) =>
      row.state === "pending" && (!presentation || !row.dismissed) &&
      (!scope || this.#inScope(row, scope, entry))
    );
  }
  permissions(
    scope?: string,
    entry?: SessionLookup,
    presentation = false,
  ): PermissionRequest[] {
    return this.#pending(scope, entry, presentation).flatMap((row) =>
      row.permission ? [row.permission] : []
    ).sort((a, b) => a.time - b.time);
  }
  questions(
    scope?: string,
    entry?: SessionLookup,
    presentation = false,
  ): QuestionRequest[] {
    return this.#pending(scope, entry, presentation).flatMap((row) =>
      row.question ? [row.question] : []
    ).sort((a, b) => a.id.localeCompare(b.id));
  }
  forms(
    scope?: string,
    entry?: SessionLookup,
    presentation = false,
  ): FormRequest[] {
    return this.#pending(scope, entry, presentation).flatMap((row) =>
      row.form ? [row.form] : []
    );
  }
  dismissed(scope: string, entry: SessionLookup): RequestLifetime[] {
    return this.#pending(scope, entry).filter((row) => row.dismissed);
  }
}
