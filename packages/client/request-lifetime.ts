// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type ContentOp,
  type FormRequest,
  type PermissionRequest,
  type QuestionRequest,
  type SessionLookup,
} from "@otk/protocol";

export type RequestKind = "permission" | "question" | "form";
export interface RequestLifetime {
  id: string;
  kind: "permission" | "input";
  sessionID?: string;
  state: "pending" | "settled-locally" | "settled-remotely" | "retired";
  reason?: string;
  dismissed: boolean;
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
/** One identity owns authority, local presentation and retained input. Views only project it. */
export class RequestLifetimes {
  #records = new Map<string, RequestLifetime>();
  #consumed = new WeakSet<RequestLifetime>();
  #listeners = new Set<() => void>();
  #revision = 0;
  #batch = 0;
  #dirty = false;
  #deleted: (id: string) => boolean = () => false;
  constructor(readonly now: () => number = () => performance.now()) {}
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
  receive(op: ContentOp): void {
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
    if (previous && previous.state !== "pending") return;
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
        state: "pending",
        dismissed: false,
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
      row.state = "retired";
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
    const row: RequestLifetime = this.get(kind, id) ??
      {
        id,
        kind: kind === "permission" ? "permission" : "input",
        state: "pending",
        dismissed: false,
      };
    if (row.state !== "pending") return;
    row.state = state;
    row.reason = reason;
    this.#records.set(key(kind, id), row);
    this.#changed();
  }
  dismiss(kind: RequestKind, id: string): void {
    const row = this.get(kind, id);
    if (row?.state === "pending") {
      row.dismissed = true;
      this.#changed();
    }
  }
  show(kind: RequestKind, id: string): void {
    const row = this.get(kind, id);
    if (row?.state === "pending") {
      row.dismissed = false;
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
        this.receive({ op: `${kind}.upsert`, request } as ContentOp);
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
