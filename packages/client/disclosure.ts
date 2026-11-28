// SPDX-License-Identifier: LGPL-3.0-only
import {
  DEFAULT_PREFS,
  type DisclosureCategory,
  type Preferences,
  type SessionTreeKind,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

export type DisclosureKind =
  | "activity"
  | "revert"
  | "silent"
  | "reasoning"
  | "record"
  | "tool"
  | "source"
  | "recordKinds"
  | "sessionBranch"
  | "taskHeading"
  | "noTask"
  | "projectBranch"
  | "archive"
  | "discovered"
  | "inactive"
  | "failureDetails"
  | "permissionScope"
  | "takeover";
export type DisclosureLifetime = "durable" | "tab" | "occurrence" | "request";
export interface DisclosurePolicy {
  lifetime: DisclosureLifetime;
  empty: "leaf" | "hide";
  /** A fixed default, or the value of the caller's Settings category (D18). */
  default: boolean | "category";
}

export const DISCLOSURE_KINDS = {
  activity: { default: "category", lifetime: "tab", empty: "hide" },
  revert: { default: false, lifetime: "tab", empty: "hide" },
  silent: { default: "category", lifetime: "tab", empty: "hide" },
  reasoning: { default: "category", lifetime: "tab", empty: "leaf" },
  record: { default: "category", lifetime: "tab", empty: "leaf" },
  tool: { default: "category", lifetime: "tab", empty: "leaf" },
  source: { default: "category", lifetime: "tab", empty: "leaf" },
  recordKinds: { default: "category", lifetime: "tab", empty: "hide" },
  sessionBranch: { default: true, lifetime: "durable", empty: "leaf" },
  taskHeading: { default: true, lifetime: "durable", empty: "leaf" },
  noTask: { default: true, lifetime: "durable", empty: "leaf" },
  projectBranch: { default: true, lifetime: "durable", empty: "leaf" },
  archive: { default: false, lifetime: "tab", empty: "hide" },
  discovered: { default: true, lifetime: "durable", empty: "hide" },
  inactive: { default: false, lifetime: "tab", empty: "hide" },
  failureDetails: { default: false, lifetime: "occurrence", empty: "hide" },
  permissionScope: { default: false, lifetime: "request", empty: "hide" },
  takeover: { default: true, lifetime: "request", empty: "leaf" },
} as const satisfies Readonly<Record<DisclosureKind, DisclosurePolicy>>;

export type DurableKind = {
  [K in DisclosureKind]: typeof DISCLOSURE_KINDS[K]["lifetime"] extends
    "durable" ? K : never;
}[DisclosureKind];

/** The persisted layout RPC keeps its existing target kinds. */
export const SESSION_TREE_DISCLOSURES = {
  task: "taskHeading",
  ungrouped: "noTask",
  session: "sessionBranch",
} as const satisfies Record<SessionTreeKind, DurableKind>;

export interface DisclosureIdentity {
  /** Lifetime scope: session, sidecar, request or failure occurrence. */
  scope: string;
  /** Stable item identity inside the scope, independent of content and layout. */
  id: string;
  generation?: string;
  /** Where the item is read, without changing its retirement scope. */
  placement?: "transcript" | "workPanel";
}
export interface DurableStore {
  read(identity: DisclosureIdentity): boolean | undefined;
  save(identity: DisclosureIdentity, open: boolean): Promise<void>;
}
export interface DisclosureState {
  open(): boolean;
  /** Whether a choice or reveal overrides the baseline for this identity. */
  chosen(): boolean;
  pending(): boolean;
  error(): unknown;
  failureOrder(): number;
  set(open: boolean): Promise<void>;
  retry(): Promise<void>;
}
export interface DisclosureContextInput {
  category?: DisclosureCategory;
  prefs?: () => Partial<Preferences>;
  /** Opens by default when there is a required failure; explicit choice wins. */
  required?: () => boolean;
}
type Retirement =
  | { scope: string; id?: string; generation?: string }
  | { kind: DisclosureKind; identity: DisclosureIdentity };

export interface Disclosures {
  bind(
    kind: DisclosureKind,
    identity: DisclosureIdentity,
    input?: DisclosureContextInput,
  ): DisclosureState;
  defaultFor(kind: DisclosureKind, input?: DisclosureContextInput): boolean;
  /** Open these identities without saving or claiming the viewport. */
  reveal(kind: DisclosureKind, identities: readonly DisclosureIdentity[]): void;
  retire(target: Retirement): void;
  subscribe(
    listener: () => void,
    kind?: DisclosureKind,
    identity?: DisclosureIdentity,
  ): () => void;
  clear(): void;
}

function defaultFor(
  kind: DisclosureKind,
  input?: DisclosureContextInput,
): boolean {
  if (input?.required?.()) return true;
  const policy = DISCLOSURE_KINDS[kind].default;
  if (policy !== "category") return policy;
  const defaults = { ...DEFAULT_PREFS, ...input?.prefs?.() };
  const categories: Record<DisclosureCategory, boolean> = {
    work: false,
    toolOutput: defaults.expandToolOutput,
    reasoning: defaults.thinking === "show",
    fileChanges: !defaults.collapseFileChanges,
    system: defaults.expandSystem,
    delegation: defaults.expandDelegation,
    outgoing: defaults.expandOutgoing,
    compaction: defaults.expandCompaction,
    record: defaults.expandRecords,
    stepMarkers: defaults.expandStepMarkers,
    snapshots: defaults.expandSnapshots,
    source: defaults.expandSource,
  };
  return categories[input?.category ?? "record"];
}

interface Entry {
  kind: DisclosureKind;
  identity: DisclosureIdentity;
  intent?: boolean;
  revision: number;
  pending: boolean;
  error?: unknown;
  failureOrder?: number;
  tail?: Promise<void>;
}
const keyOf = (
  kind: DisclosureKind,
  { scope, id, generation, placement }: DisclosureIdentity,
) =>
  JSON.stringify([
    kind,
    scope,
    id,
    generation ?? "",
    placement ?? "transcript",
  ]);

/** Local intent is immediate, and durable writes for each identity are ordered. */
export function createDisclosures({
  factory = createState,
  durable,
}: {
  factory?: StateFactory;
  durable?: Partial<Record<DurableKind, DurableStore>>;
}): Disclosures {
  const clock = factory({ revision: 0 });
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  let failures = 0;
  const storeFor = (kind: DisclosureKind) => {
    if (DISCLOSURE_KINDS[kind].lifetime !== "durable" || !durable) return;
    const store = durable[kind as DurableKind];
    if (!store) throw new Error(`No durable disclosure store for ${kind}`);
    return store;
  };
  const entryFor = (
    key: string,
    kind: DisclosureKind,
    identity: DisclosureIdentity,
  ) => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { kind, identity: { ...identity }, revision: 0, pending: false };
      entries.set(key, entry);
    }
    return entry;
  };
  const publish = (
    keys: readonly string[],
    kinds: Iterable<DisclosureKind>,
  ) => {
    clock.update((draft) => {
      draft.revision++;
    });
    const notify = new Set(listeners.get(""));
    for (const key of [...keys, ...kinds]) {
      for (const listener of listeners.get(key) ?? []) notify.add(listener);
    }
    for (const listener of notify) listener();
  };
  const retire = (matches: (entry: Entry, key: string) => boolean) => {
    const keys: string[] = [], kinds = new Set<DisclosureKind>();
    for (const [key, entry] of entries) {
      if (!matches(entry, key)) continue;
      entries.delete(key);
      keys.push(key);
      kinds.add(entry.kind);
    }
    if (keys.length) publish(keys, kinds);
  };
  return {
    bind(kind, identity, input) {
      const store = storeFor(kind);
      const key = keyOf(kind, identity);
      const value = entryFor(key, kind, identity);
      const current = () => entries.get(key) === value;
      const read = () => {
        void clock.state.revision;
        return current() ? value : undefined;
      };
      const baseline = () => store?.read(value.identity);
      const intent = (saved: boolean | undefined) => {
        const state = read();
        if (
          state && store && !state.pending && !state.failureOrder &&
          state.intent === (saved ?? defaultFor(kind))
        ) {
          state.intent = undefined;
        }
        return state?.intent;
      };
      const open = () => {
        const saved = baseline();
        return intent(saved) ?? saved ?? defaultFor(kind, input);
      };
      const set = (open: boolean): Promise<void> => {
        if (!current()) return Promise.resolve();
        const revision = ++value.revision;
        value.intent = open;
        value.error = undefined;
        value.failureOrder = undefined;
        if (!store) {
          publish([key], [kind]);
          return Promise.resolve();
        }
        value.pending = true;
        const persist = async () => {
          try {
            await store.save(value.identity, open);
          } catch (error) {
            if (current() && value.revision === revision) {
              value.error = error;
              value.failureOrder = ++failures;
            }
          } finally {
            if (current() && value.revision === revision) {
              value.pending = false;
              publish([key], [kind]);
            }
          }
        };
        const work = value.tail ? value.tail.then(persist) : persist();
        value.tail = work;
        publish([key], [kind]);
        return work;
      };
      return {
        open,
        chosen: () => intent(baseline()) !== undefined,
        pending: () => read()?.pending ?? false,
        error: () => read()?.error,
        failureOrder: () => read()?.failureOrder ?? 0,
        set,
        retry: () => set(open()),
      };
    },
    defaultFor,
    reveal(kind, identities) {
      storeFor(kind);
      const keys = new Set<string>();
      for (const identity of identities) {
        const key = keyOf(kind, identity);
        entryFor(key, kind, identity).intent = true;
        keys.add(key);
      }
      if (keys.size) publish([...keys], [kind]);
    },
    retire(target) {
      if ("identity" in target) {
        const exact = keyOf(target.kind, target.identity);
        retire((_, key) => key === exact);
      } else {
        retire(({ identity }) =>
          identity.scope === target.scope &&
          (target.id === undefined || identity.id === target.id) &&
          (target.generation === undefined ||
            identity.generation === target.generation)
        );
      }
    },
    subscribe(listener, kind, identity) {
      const key = kind ? (identity ? keyOf(kind, identity) : kind) : "";
      let selected = listeners.get(key);
      if (!selected) listeners.set(key, selected = new Set());
      selected.add(listener);
      return () => {
        selected.delete(listener);
        if (!selected.size && listeners.get(key) === selected) {
          listeners.delete(key);
        }
      };
    },
    clear() {
      retire(() => true);
    },
  };
}
