// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import {
  type IndexEntry,
  type ServerFrame,
  type SessionUsage,
  usageHeader,
  UsageLedger,
  type UsageMessage,
  type UsageTool,
  usageTool,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { SidecarConnection } from "./connection.ts";
import type { Selection } from "./session.ts";
import { type ClientIndex, createIndex, sessionKey } from "./index.ts";

type Target = Pick<Selection, "sidecarId" | "sessionID">;
/** One-shot API readers get bounded reuse; mounted consumers retain a lease. */
const UNRETAINED_TARGET_LIMIT = 32;
type UsageChange = { message: UsageMessage } | { remove: string } | {
  messageID: string;
  tool: UsageTool;
} | { messageID: string; removeTool: string };
export interface UsageState {
  entries: Record<
    string,
    { value?: SessionUsage; loading: boolean; error?: string }
  >;
}
export interface SessionUsageOwner {
  state: UsageState;
  subscribe(listener: (state: UsageState) => void): () => void;
  get(target: Target): SessionUsage | undefined;
  load(target: Target, refresh?: boolean): Promise<void>;
  /** Independent consumers share work until the last identity-bound lease ends. */
  retain(target: Target): () => void;
  scope(): { set(targets: readonly Target[]): void; dispose(): void };
  removeServer(sidecar: string): void;
  receive(sidecar: string, frame: ServerFrame): void;
  stop(): void;
}
/** Full-session metadata only. Views never reconstruct totals from loaded content. */
export function createSessionUsage(
  connection: (id: string) => SidecarConnection,
  factory: StateFactory = createState,
  metadata?: (target: Target) => IndexEntry | undefined,
): SessionUsageOwner {
  const { state, update, subscribe } = factory<UsageState>({ entries: {} });
  let stopped = false;
  let index: ClientIndex | undefined;
  const indexed = (target: Target) =>
    metadata
      ? metadata(target)
      : index?.get(target.sidecarId, target.sessionID);
  const resources = new Map<
    string,
    {
      target: Target;
      ledger?: UsageLedger;
      pending?: Promise<void>;
      events: UsageChange[];
      controller?: AbortController;
      again: boolean;
      leases: number;
      revision?: number;
    }
  >();
  const publish = (
    key: string,
    value?: SessionUsage,
    error?: string,
    loading = false,
  ) =>
    update((draft) => {
      draft.entries[key] = { value, error, loading };
    });
  const apply = (ledger: UsageLedger, event: UsageChange) => {
    if ("message" in event) ledger.upsert(event.message);
    else if ("remove" in event) ledger.remove(event.remove);
    else if ("tool" in event) ledger.tool(event.messageID, event.tool);
    else ledger.removeTool(event.messageID, event.removeTool);
  };
  const load = (target: Target, refresh = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    const key = sessionKey(target.sidecarId, target.sessionID);
    if (indexed(target)?.deleted) {
      if (resources.has(key)) remove(key);
      return Promise.resolve();
    }
    let resource = resources.get(key);
    if (!resource) {
      resources.set(
        key,
        resource = {
          target: { ...target },
          events: [],
          again: false,
          leases: 0,
          revision: indexed(target)?.digest.revision,
        },
      );
    }
    resources.delete(key);
    resources.set(key, resource);
    trim();
    if (!connection(target.sidecarId).supports("usage")) {
      resource.controller?.abort();
      resource.ledger = undefined;
      publish(key);
      return Promise.resolve();
    }
    if (resource.pending) {
      if (refresh) resource.again = true;
      return resource.pending;
    }
    if (resource.ledger && !refresh) return Promise.resolve();
    const owner = resource, abort = owner.controller = new AbortController();
    owner.events = [];
    const work = Promise.resolve().then(async () => {
      try {
        const snapshot = await connection(target.sidecarId).rpc.call(
          "usage.get",
          { sessionID: target.sessionID },
          abort.signal,
        );
        if (resources.get(key) !== owner || abort.signal.aborted) return;
        if (snapshot.sessionID !== target.sessionID) {
          throw new Error("Usage snapshot session mismatch");
        }
        const ledger = new UsageLedger(snapshot.sessionID, snapshot.messages);
        for (const event of owner.events) apply(ledger, event);
        owner.ledger = ledger;
        publish(key, ledger.snapshot());
      } catch (error) {
        if (resources.get(key) === owner && !abort.signal.aborted) {
          publish(key, owner.ledger?.snapshot(), errorMessage(error));
        }
      } finally {
        if (owner.controller === abort) {
          owner.pending = undefined;
          owner.events = [];
          if (resources.get(key) === owner && owner.again) {
            owner.again = false;
            void load(target, true);
          }
        }
      }
    });
    owner.pending = work;
    publish(key, owner.ledger?.snapshot(), undefined, true);
    return work;
  };
  const remove = (key: string) => {
    resources.get(key)?.controller?.abort();
    resources.delete(key);
    update((draft) => {
      delete draft.entries[key];
    });
  };
  const trim = () => {
    let unretained =
      [...resources.values()].filter((resource) => !resource.leases).length;
    for (const [key, resource] of resources) {
      if (unretained <= UNRETAINED_TARGET_LIMIT) break;
      if (resource.leases) continue;
      remove(key);
      unretained--;
    }
  };
  const retain = (target: Target): () => void => {
    if (stopped || indexed(target)?.deleted) return () => {};
    const key = sessionKey(target.sidecarId, target.sessionID);
    let resource = resources.get(key);
    if (!resource) {
      resource = {
        target: { ...target },
        events: [],
        again: false,
        leases: 0,
        revision: indexed(target)?.digest.revision,
      };
      resources.set(key, resource);
    }
    const owner = resource;
    owner.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--owner.leases === 0 && resources.get(key) === owner) remove(key);
    };
  };
  return {
    state,
    subscribe,
    load,
    retain,
    scope() {
      const leases = new Map<string, () => void>();
      let disposed = false;
      return {
        set(targets) {
          if (disposed) return;
          const keys = new Set(
            targets.map((target) =>
              sessionKey(target.sidecarId, target.sessionID)
            ),
          );
          for (const [key, release] of leases) {
            if (!keys.has(key)) {
              leases.delete(key);
              release();
            }
          }
          for (const target of targets) {
            const key = sessionKey(target.sidecarId, target.sessionID);
            if (leases.has(key)) continue;
            leases.set(key, retain(target));
            void load(target);
          }
        },
        dispose() {
          disposed = true;
          for (const release of leases.values()) release();
          leases.clear();
        },
      };
    },
    removeServer(sidecar) {
      index?.remove(sidecar);
      for (const [key, resource] of resources) {
        if (resource.target.sidecarId === sidecar) remove(key);
      }
    },
    get: (target) =>
      indexed(target)?.deleted
        ? undefined
        : state.entries[sessionKey(target.sidecarId, target.sessionID)]?.value,
    receive(sidecar, frame) {
      if (stopped) return;
      if (frame.t === "welcome" || frame.t === "resync") {
        if (frame.t === "welcome") index?.remove(sidecar);
        for (const resource of [...resources.values()]) {
          if (resource.target.sidecarId === sidecar) {
            resource.controller?.abort();
            resource.pending = undefined;
            void load(resource.target, true);
          }
        }
      } else if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (!metadata && !(index ??= createIndex()).receive(sidecar, frame)) {
          return;
        }
        for (const [key, resource] of [...resources]) {
          if (resource.target.sidecarId !== sidecar) continue;
          const entry = indexed(resource.target);
          if (!entry || entry.deleted) {
            remove(key);
            continue;
          }
          const revision = entry.digest.revision;
          if (resource.revision !== undefined && revision < resource.revision) {
            continue;
          }
          if (resource.revision !== revision) {
            const initial = resource.revision === undefined;
            resource.revision = revision;
            if (!initial || (frame.t === "index.patch" && revision > 0)) {
              void load(resource.target, true);
            }
          }
        }
      } else if (frame.t === "content") {
        const key = sessionKey(sidecar, frame.sessionID),
          resource = resources.get(key);
        if (!resource) return;
        const event = frame.event;
        // A transcript header's legacy numeric defaults and content removals
        // are not charged-history authority. Bound details follow digest
        // revisions and the explicit reader; existing tool labels remain live.
        if (
          metadata &&
          (event.op === "message.upsert" || event.op === "message.remove")
        ) return;
        const tool = event.op === "part.upsert"
          ? usageTool(event.part)
          : undefined;
        const change: UsageChange | undefined = event.op === "message.remove"
          ? { remove: event.messageID }
          : event.op === "message.upsert" && event.message.role === "assistant"
          ? { message: usageHeader(event.message) }
          : event.op === "part.upsert" && tool
          ? { messageID: event.messageID, tool }
          : event.op === "part.remove"
          ? { messageID: event.messageID, removeTool: event.partID }
          : undefined;
        if (!change) return;
        if (resource.pending) resource.events.push(change);
        if (resource.ledger) {
          apply(resource.ledger, change);
          publish(
            key,
            resource.ledger.snapshot(),
            undefined,
            !!resource.pending,
          );
        }
      }
    },
    stop() {
      stopped = true;
      for (const resource of resources.values()) resource.controller?.abort();
      resources.clear();
      update((draft) => {
        draft.entries = {};
      });
    },
  };
}
