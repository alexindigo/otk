// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue } from "@otk/protocol";
import {
  compareTranscriptVersion,
  type ContentClock,
  type ContentOp,
  type IndexEntry,
  type ModelCatalog,
  type ServerFrame,
  type TranscriptVersion,
  type TurnUsageDetail,
  usageHeader,
  UsageLedger,
  type UsageMessage,
  type UsageTool,
  usageTool,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { failureText } from "./failure-features.ts";
import type { SidecarConnection } from "./connection.ts";
import { type ClientIndex, createIndex } from "./index.ts";
import { createTurnPricing, type TurnUsage } from "./usage.ts";

export interface UsageTarget {
  sidecarId: string;
  sessionID: string;
  turnID: string;
}
export const usageKey = (target: UsageTarget): string =>
  JSON.stringify([target.sidecarId, target.sessionID, target.turnID]);
type DetailOp = { message: UsageMessage; restart?: boolean } | {
  remove: string;
} | {
  messageID: string;
  tool: UsageTool;
} | { messageID: string; removeTool: string };
function detailOp(event: ContentOp, turnID: string): DetailOp | undefined {
  if (
    event.op === "message.upsert" && event.message.role === "assistant" &&
    (event.message.replyTo ?? event.message.id) === turnID
  ) return { message: usageHeader(event.message), restart: event.restart };
  if (event.op === "message.remove") return { remove: event.messageID };
  if (event.op === "part.upsert") {
    const tool = usageTool(event.part);
    if (tool) return { messageID: event.messageID, tool };
  }
  if (event.op === "part.remove") {
    return { messageID: event.messageID, removeTool: event.partID };
  }
}
export interface UsageState {
  entries: Record<
    string,
    { value?: TurnUsageDetail; loading: boolean; error?: string }
  >;
}
export interface SessionUsageOwner {
  readonly state: UsageState;
  subscribe(listener: (state: UsageState) => void): () => void;
  get(target: UsageTarget): TurnUsageDetail | undefined;
  priced(target: UsageTarget, catalog?: ModelCatalog): TurnUsage | undefined;
  error(target: UsageTarget): string | undefined;
  load(target: UsageTarget, refresh?: boolean): Promise<void>;
  retain(target: UsageTarget): () => void;
  removeServer(sidecar: string): void;
  receive(sidecar: string, frame: ServerFrame): void;
  stop(): void;
}
/** Only explicit turn-detail consumers acquire metadata. Footer summaries remain index-owned. */
export function createSessionUsage(
  connection: (id: string) => SidecarConnection,
  factory: StateFactory = createState,
  metadata?: (target: UsageTarget) => IndexEntry | undefined,
): SessionUsageOwner {
  const state: UsageState = { entries: {} };
  const binding = factory({ revision: 0 });
  let stopped = false, index: ClientIndex | undefined;
  const indexed = (target: UsageTarget) =>
    metadata
      ? metadata(target)
      : index?.get(target.sidecarId, target.sessionID);
  interface Resource {
    target: UsageTarget;
    ledger?: UsageLedger;
    value?: TurnUsageDetail;
    positions: Map<string, number>;
    price: ReturnType<typeof createTurnPricing>;
    leases: number;
    pending?: Promise<void>;
    controller?: AbortController;
    clock?: ContentClock;
    minimum?: TranscriptVersion;
    retriedVersion?: TranscriptVersion;
    events: { event: DetailOp; seq?: number; epoch?: string }[];
    bytes: number;
    overflow: boolean;
    again: boolean;
    summary?: string;
    retry?: ReturnType<typeof setTimeout>;
  }
  const resources = new Map<string, Resource>();
  const notify = () =>
    binding.update((draft) => {
      draft.revision++;
    });
  const publish = (
    key: string,
    resource: Resource,
    loading = false,
    error?: string,
  ) => {
    state.entries[key] = { value: resource.value, loading, error };
    notify();
  };
  const ensure = (target: UsageTarget) => {
    const key = usageKey(target);
    let resource = resources.get(key);
    if (!resource) {
      resource = {
        target: { ...target },
        positions: new Map(),
        price: createTurnPricing(),
        leases: 0,
        events: [],
        bytes: 0,
        overflow: false,
        again: false,
        summary: JSON.stringify(
          derivedValue(indexed(target)?.digest.turns[target.turnID]),
        ),
      };
      resources.set(key, resource);
      let unleased = [...resources.values()].filter((item) =>
        !item.leases
      ).length;
      for (const [oldKey, item] of resources) {
        if (unleased <= 32) break;
        if (!item.leases && oldKey !== key) {
          remove(oldKey);
          unleased--;
        }
      }
    }
    return resource;
  };
  const apply = (ledger: UsageLedger, event: DetailOp) => {
    if ("message" in event) return ledger.upsert(event.message, event.restart);
    if ("remove" in event) return ledger.remove(event.remove);
    if ("tool" in event) return ledger.tool(event.messageID, event.tool);
    return ledger.removeTool(event.messageID, event.removeTool);
  };
  const updated = (resource: Resource, event: DetailOp) => {
    if (!resource.ledger || !resource.value) return;
    const change = apply(resource.ledger, event);
    if (!change?.turns.length) return;
    const calls = [...resource.value.calls];
    const reindex = () => {
      resource.positions = new Map(calls.map((call, i) => [call.id, i]));
    };
    for (const id of change.calls.remove) {
      const at = resource.positions.get(id);
      if (at !== undefined) {
        calls.splice(at, 1);
        reindex();
      }
    }
    for (const call of change.calls.upsert) {
      const at = resource.positions.get(call.id);
      if (at !== undefined && calls[at].time?.start === call.time?.start) {
        calls[at] = call;
        continue;
      }
      if (at !== undefined) calls.splice(at, 1);
      let low = 0, high = calls.length;
      while (low < high) {
        const mid = (low + high) >>> 1, value = calls[mid];
        const order = (value.time?.start ?? 0) - (call.time?.start ?? 0) ||
          value.id.localeCompare(call.id);
        if (order < 0) low = mid + 1;
        else high = mid;
      }
      calls.splice(low, 0, call);
      reindex();
    }
    resource.value = {
      ...resource.value,
      clock: resource.clock ?? resource.value.clock,
      calls,
      summary: resource.ledger.summary(resource.target.turnID) ??
        new UsageLedger(
          resource.target.sessionID,
          [],
          resource.value.aggregation,
        ).detail(
          resource.target.turnID,
        ).summary,
    };
  };
  const remove = (key: string) => {
    const resource = resources.get(key);
    resource?.controller?.abort();
    clearTimeout(resource?.retry);
    resources.delete(key);
    delete state.entries[key];
    notify();
  };
  const schedule = (resource: Resource) => {
    const policy = connection(resource.target.sidecarId).messages;
    if (!policy || !resource.leases || resource.retry !== undefined) return;
    resource.retry = setTimeout(() => {
      resource.retry = undefined;
      if (resources.get(usageKey(resource.target)) === resource) {
        void load(resource.target, true);
      }
    }, policy.retryms);
  };
  const load = (target: UsageTarget, refresh = false): Promise<void> => {
    if (
      stopped || indexed(target)?.deleted ||
      !connection(target.sidecarId).supports("usage")
    ) return Promise.resolve();
    const key = usageKey(target), resource = ensure(target);
    if (resource.pending) {
      if (refresh) resource.again = true;
      return resource.pending;
    }
    if (resource.value && !refresh) return Promise.resolve();
    clearTimeout(resource.retry);
    resource.retry = undefined;
    const abort = resource.controller = new AbortController();
    resource.events = [];
    resource.bytes = 0;
    resource.overflow = false;
    const admitted = resource.minimum;
    const work = Promise.resolve().then(async () => {
      try {
        const value = await connection(target.sidecarId).rpc.call("usage.get", {
          sessionID: target.sessionID,
          turnID: target.turnID,
        }, abort.signal);
        if (resources.get(key) !== resource || abort.signal.aborted) return;
        if (
          resource.minimum &&
          compareTranscriptVersion(value.version, resource.minimum) < 0
        ) {
          if (
            !resource.retriedVersion ||
            compareTranscriptVersion(
                resource.retriedVersion,
                resource.minimum,
              ) < 0
          ) {
            resource.retriedVersion = resource.minimum;
            resource.again = true;
            return;
          }
          throw new Error("Refreshing usage breakdown…");
        }
        if (
          value.sessionID !== target.sessionID ||
          value.turnID !== target.turnID || value.calls.some((call) =>
            call.turnID !== target.turnID
          )
        ) throw new Error("Usage detail identity mismatch");
        if (resource.overflow) throw new Error("Refreshing usage breakdown…");
        const ledger = new UsageLedger(
          value.sessionID,
          value.calls,
          value.aggregation,
        );
        const candidate = {
          ...resource,
          clock: value.clock,
          ledger,
          positions: new Map(value.calls.map((call, i) => [call.id, i])),
          value: {
            ...value,
            calls: value.calls.map((call) => ledger.call(call.id)!),
          },
        };
        for (const event of resource.events) {
          if (event.epoch && event.epoch !== value.clock.epoch) {
            throw new Error("Usage checkpoint changed");
          }
          if (event.seq === undefined || event.seq > value.clock.seq) {
            if (event.seq !== undefined && event.epoch) {
              candidate.clock = { epoch: event.epoch, seq: event.seq };
            }
            updated(candidate, event.event);
          }
        }
        resource.ledger = candidate.ledger;
        resource.value = candidate.value;
        resource.positions = candidate.positions;
        resource.clock = candidate.clock;
        resource.minimum = value.version;
        publish(key, resource);
      } catch (error) {
        if (resources.get(key) === resource && !abort.signal.aborted) {
          if (admitted !== resource.minimum) {
            resource.again = true;
            return;
          }
          publish(key, resource, false, failureText(error));
          schedule(resource);
        }
      } finally {
        if (resource.controller === abort) {
          resource.pending = undefined;
          resource.events = [];
          resource.bytes = 0;
          if (resources.get(key) === resource && resource.again) {
            resource.again = false;
            if (resource.retry === undefined) {
              queueMicrotask(() => void load(target, true));
            }
          }
        }
      }
    });
    resource.pending = work;
    publish(key, resource, true);
    return work;
  };
  return {
    get state() {
      void binding.state.revision;
      return state;
    },
    subscribe: (listener) => binding.subscribe(() => listener(state)),
    get(target) {
      void binding.state.revision;
      return state.entries[usageKey(target)]?.value;
    },
    priced(target, catalog) {
      void binding.state.revision;
      const resource = resources.get(usageKey(target));
      return resource?.price(resource.value, catalog);
    },
    error(target) {
      void binding.state.revision;
      return state.entries[usageKey(target)]?.error;
    },
    load,
    retain(target) {
      if (stopped || indexed(target)?.deleted) return () => {};
      const resource = ensure(target);
      resource.leases++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (
          --resource.leases === 0 &&
          resources.get(usageKey(target)) === resource
        ) remove(usageKey(target));
      };
    },
    removeServer(sidecar) {
      index?.remove(sidecar);
      for (const [key, resource] of resources) {
        if (resource.target.sidecarId === sidecar) remove(key);
      }
    },
    receive(sidecar, frame) {
      if (stopped) return;
      if (
        (frame.t === "index.snapshot" || frame.t === "index.patch") &&
        !metadata && !(index ??= createIndex()).receive(sidecar, frame)
      ) return;
      for (const [key, resource] of resources) {
        if (resource.target.sidecarId !== sidecar) continue;
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          const entry = indexed(resource.target);
          if (!entry || entry.deleted) {
            remove(key);
            continue;
          }
          const summary = JSON.stringify(
            derivedValue(entry.digest.turns[resource.target.turnID]),
          );
          if (resource.summary !== summary) {
            resource.summary = summary;
            if (JSON.stringify(resource.value?.summary) !== summary) {
              void load(resource.target, true);
            }
          }
        } else if (frame.t === "transcript.invalidated") {
          if (
            frame.sessionID !== undefined &&
            frame.sessionID !== resource.target.sessionID
          ) continue;
          if (
            resource.minimum &&
            compareTranscriptVersion(frame.version, resource.minimum) <= 0
          ) continue;
          resource.minimum = frame.version;
          if (
            resource.value &&
            compareTranscriptVersion(resource.value.version, frame.version) >= 0
          ) continue;
          resource.clock = undefined;
          if (!resource.pending) void load(resource.target, true);
        } else if (frame.t === "welcome") {
          resource.minimum = undefined;
          resource.controller?.abort();
          resource.pending = undefined;
          resource.clock = undefined;
          void load(resource.target, true);
        } else if (
          frame.t === "content" && frame.sessionID === resource.target.sessionID
        ) {
          const event = detailOp(frame.event, resource.target.turnID);
          if (!event) continue;
          if (frame.clock && resource.clock) {
            if (frame.clock.epoch !== resource.clock.epoch) {
              resource.controller?.abort();
              resource.pending = undefined;
              resource.clock = undefined;
              void load(resource.target, true);
              continue;
            }
            if (frame.clock.seq <= resource.clock.seq) continue;
          }
          if (resource.pending && !resource.overflow) {
            const policy = connection(sidecar).messages;
            if (!policy) {
              resource.overflow = true;
              resource.events = [];
              continue;
            }
            const bytes =
              new TextEncoder().encode(JSON.stringify(event)).byteLength;
            if (
              resource.events.length >= policy.replayops ||
              resource.bytes + bytes > policy.replaybytes
            ) {
              // Invalidate before dropping the superseded capture. One failed read, one delayed retry.
              resource.overflow = true;
              resource.events = [];
              resource.bytes = 0;
            } else {
              resource.events.push({
                event,
                seq: frame.clock?.seq,
                epoch: frame.clock?.epoch,
              });
              resource.bytes += bytes;
            }
          }
          if (resource.value && resource.clock === undefined) continue;
          if (frame.clock) resource.clock = frame.clock;
          const previous = resource.value;
          updated(resource, event);
          if (resource.value !== previous) {
            publish(key, resource, !!resource.pending);
          }
        }
      }
    },
    stop() {
      stopped = true;
      for (const key of resources.keys()) remove(key);
      index = undefined;
    },
  };
}
