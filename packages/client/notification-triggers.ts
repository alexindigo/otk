// SPDX-License-Identifier: LGPL-3.0-only
import type { IndexEntry, ServerFrame } from "@otk/protocol";
import { acceptsPatch, sessionKey } from "./index.ts";
import type { Note } from "./notifications.ts";
type IndexFrame = Extract<ServerFrame, { t: "index.snapshot" | "index.patch" }>;
function errors(entry: IndexEntry): string {
  return JSON.stringify(
    entry.attention.errorState?.observations.filter((o) => !o.cleared) ??
      entry.attention.error ?? "",
  );
}
const permissions = (e: IndexEntry) =>
  e.attention.permissions + e.attention.childPermissions;
const questions = (e: IndexEntry) =>
  e.attention.questions + e.attention.childQuestions;
/** Uses authoritative root roll-ups; does not double-count descendants. */
export class NotificationTriggers {
  #connections = new Map<
    string,
    { rev: number; entries: Map<string, IndexEntry> }
  >();
  #kinds = new Map<string, Note["kind"]>();
  constructor(
    readonly emit: (note: Note) => void,
    readonly retract: (id: string) => void,
  ) {}
  reset(sidecar: string): void {
    this.#connections.delete(sidecar);
    for (const key of [...this.#kinds.keys()]) {
      if (key.startsWith(sidecar + "/")) {
        this.#kinds.delete(key);
        this.retract(key);
      }
    }
  }
  receive(sidecar: string, frame: IndexFrame): boolean {
    const previous = this.#connections.get(sidecar);
    if (!acceptsPatch(previous?.rev, frame)) return false;
    const entries = frame.t === "index.snapshot"
      ? new Map(
        frame.entries.map((entry) => [entry.id, structuredClone(entry)]),
      )
      : new Map(previous!.entries);
    if (frame.t === "index.patch") {
      for (const op of frame.ops) {
        if (op.op === "upsert") {
          entries.set(op.entry.id, structuredClone(op.entry));
        } else entries.delete(op.id);
      }
    }
    this.#connections.set(sidecar, { rev: frame.rev, entries });
    if (!previous) return true; // first snapshot after every welcome is baseline
    for (const old of previous.entries.values()) {
      const entry = entries.get(old.id), id = sessionKey(sidecar, old.id);
      if (!entry || entry.parentID || entry.archived) {
        if (this.#kinds.delete(id)) this.retract(id);
        continue;
      }
      if (old.parentID || old.archived) continue;
      const pending = this.#kinds.get(id);
      const resolved = (pending === "permission" && !permissions(entry)) ||
        (pending === "question" && !questions(entry)) ||
        (pending === "error" && !entry.attention.error) ||
        (pending === "done" && entry.status !== "idle");
      // A root owns all family attention. Resolving one kind must expose any
      // remaining kind rather than clearing that root's channels and badge.
      const remaining = resolved
        ? entry.attention.error
          ? "error"
          : permissions(entry)
          ? "permission"
          : questions(entry)
          ? "question"
          : undefined
        : undefined;
      const kind: Note["kind"] | undefined =
        entry.attention.error && errors(entry) !== errors(old)
          ? "error"
          : permissions(entry) > permissions(old)
          ? "permission"
          : questions(entry) > questions(old)
          ? "question"
          : old.status !== "idle" && entry.status === "idle" &&
              !entry.attention.error && !permissions(entry) && !questions(entry)
          ? "done"
          : remaining;
      if (kind) {
        this.#kinds.set(id, kind);
        this.emit({
          id,
          kind,
          sessionRef: { sidecar, session: entry.id },
          title: ({
            done: "Session done",
            permission: "Permission needed",
            question: "Question needs input",
            error: "Session error",
            info: "Information",
          })[kind],
          body: kind === "error"
            ? `${entry.title}: ${entry.attention.error}`
            : entry.title,
          actions: [{
            label: "Open",
            command: "session.open",
            args: { sidecarId: sidecar, sessionID: entry.id },
            default: true,
          }],
        });
      } else {
        if (resolved) {
          this.#kinds.delete(id);
          this.retract(id);
        }
      }
    }
    return true;
  }
}
