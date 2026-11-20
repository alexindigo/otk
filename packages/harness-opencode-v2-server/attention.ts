// SPDX-License-Identifier: LGPL-3.0-only
import { sessionAncestors, type SessionLookup } from "@otk/protocol";

/** One projection for native request ownership, including every loaded ancestor. */
export function pendingAttention(
  id: string,
  requests: Iterable<
    { sessionID: string; kind: "permission" | "form"; stale?: boolean }
  >,
  lookup: SessionLookup,
) {
  const attention = {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  };
  let stale = false;
  for (const request of requests) {
    const direct = request.sessionID === id;
    if (!direct && !sessionAncestors(request.sessionID, lookup).includes(id)) {
      continue;
    }
    stale ||= !!request.stale;
    if (request.kind === "permission") {
      if (direct) attention.permissions++;
      else attention.childPermissions++;
    } else if (direct) attention.questions++;
    else attention.childQuestions++;
  }
  return { attention, stale };
}

type PendingRequest = {
  id: string;
  sessionID: string;
  kind: "permission" | "form";
  stale?: boolean;
};
/** Request deltas touch only their owner and ancestor path, never the family.
 * Full replacement/reparenting belongs to inventory or metadata refresh work. */
export class PendingAttentionIndex {
  #requests = new Map<string, { request: PendingRequest; path: string[] }>();
  #parents = new Map<string, string | undefined>();
  #counts = new Map<string, {
    permissions: number;
    questions: number;
    childPermissions: number;
    childQuestions: number;
    stale: number;
    direct: Map<string, PendingRequest>;
  }>();
  constructor(readonly lookup: SessionLookup) {}
  #path(request: PendingRequest, lookup = this.lookup) {
    return [
      request.sessionID,
      ...sessionAncestors(request.sessionID, (id) => {
        const row = lookup(id);
        this.#parents.set(id, row?.parentID);
        return row;
      }),
    ];
  }
  #apply(key: string, request: PendingRequest, path: string[], delta: 1 | -1) {
    for (const id of path) {
      let row = this.#counts.get(id);
      if (!row) {
        this.#counts.set(
          id,
          row = {
            permissions: 0,
            questions: 0,
            childPermissions: 0,
            childQuestions: 0,
            stale: 0,
            direct: new Map(),
          },
        );
      }
      const direct = id === request.sessionID;
      const field = request.kind === "permission"
        ? direct ? "permissions" : "childPermissions"
        : direct
        ? "questions"
        : "childQuestions";
      row[field] += delta;
      if (request.stale) row.stale += delta;
      if (direct) {
        if (delta === 1) row.direct.set(key, request);
        else row.direct.delete(key);
      }
      if (
        !row.permissions && !row.questions && !row.childPermissions &&
        !row.childQuestions
      ) this.#counts.delete(id);
    }
  }
  set(key: string, request?: PendingRequest): void {
    const previous = this.#requests.get(key);
    if (previous) this.#apply(key, previous.request, previous.path, -1);
    this.#requests.delete(key);
    if (!request) return;
    const path = this.#path(request);
    this.#requests.set(key, { request, path });
    this.#apply(key, request, path, 1);
  }
  replace(requests: Iterable<[string, PendingRequest]>): void {
    this.clear();
    for (const [key, request] of requests) this.set(key, request);
  }
  reparent(entry: { id: string; parentID?: string }): Set<string> {
    const changed = new Set<string>();
    if (
      !this.#parents.has(entry.id) ||
      this.#parents.get(entry.id) === entry.parentID
    ) return changed;
    this.#parents.set(entry.id, entry.parentID);
    const lookup: SessionLookup = (id) =>
      id === entry.id ? entry : this.lookup(id);
    for (const [key, row] of this.#requests) {
      if (!row.path.includes(entry.id)) continue;
      this.#apply(key, row.request, row.path, -1);
      const path = this.#path(row.request, lookup);
      for (const id of [...row.path, ...path]) changed.add(id);
      row.path = path;
      this.#apply(key, row.request, path, 1);
    }
    return changed;
  }
  get(id: string) {
    const row = this.#counts.get(id);
    const { direct, stale, ...attention } = row ?? {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
      direct: new Map<string, PendingRequest>(),
      stale: 0,
    };
    const own = [...direct.values()].filter((request) => !request.stale);
    return {
      attention,
      stale: stale > 0,
      permissions: own.filter((request) => request.kind === "permission").map((
        request,
      ) => request.id),
      inputs: own.filter((request) => request.kind === "form").map((request) =>
        request.id
      ),
    };
  }
  clear(): void {
    this.#requests.clear();
    this.#counts.clear();
    this.#parents.clear();
  }
}
