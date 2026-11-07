// SPDX-License-Identifier: LGPL-3.0-only
import type {
  IntentIdentity,
  ServerFrame,
  SessionListInput,
  SessionListPage,
  SessionStructure,
} from "@otk/protocol";
import type { Rpc } from "./rpc.ts";
import { SESSION_LIST_SIZE, sessionListKey } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { createProgress } from "./progress.ts";
export function createSessionLists(
  rpc: Rpc,
  epoch: () => number,
  factory: StateFactory = createState,
) {
  const store = factory({ revision: 0 });
  const progress = createProgress(factory);
  type List = {
    input: SessionListInput;
    items: SessionStructure[];
    structures: SessionStructure[];
    older: string | null;
    ready: boolean;
    loading: boolean;
    active: boolean;
    revision: number;
    generation?: string;
    visible?: readonly string[];
    dirty?: boolean;
    covered?: boolean;
    retained: Map<string, SessionStructure>;
    started: number;
    replacement?: {
      items: SessionStructure[];
      older: string | null;
      generation?: string;
      goal: number;
    };
    pending?: {
      intent: IntentIdentity;
      epoch: number;
      abort: AbortController;
      before?: string;
      revision: number;
      chunks?: SessionStructure[];
    };
  };
  const lists = new Map<string, List>();
  const projections = new WeakMap<List, {
    source: SessionStructure[];
    context: readonly (SessionStructure & { retained?: boolean })[];
    value: SessionStructure[];
  }>();
  let stopped = false;
  const changed = () =>
    store.update((draft) => {
      draft.revision++;
    });
  const apply = (list: List, page: SessionListPage) => {
    const pending = list.pending;
    if (
      !pending || page.load.id !== pending.intent.key ||
      page.load.revision <= pending.revision ||
      page.load.boundary.kind !== "page" ||
      page.load.boundary.before !== pending.before ||
      page.load.boundary.limit !== (list.input.limit ?? SESSION_LIST_SIZE) ||
      page.load.scope.kind !== "project-sessions" ||
      page.load.scope.directory !== list.input.directory ||
      (page.load.scope.query ?? "") !== (list.input.query ?? "") ||
      page.load.scope.parentID !== list.input.parentID
    ) return;
    const expected = list.replacement?.generation ??
      (pending.before ? list.generation : undefined);
    if (
      expected && expected !== page.load.generation &&
      page.load.generation !== "pending"
    ) return;
    pending.revision = page.load.revision;
    progress.receive(sessionListKey(list.input), {
      generation: pending.intent.key,
      phase: page.load.state === "complete" ? "ready" : "reading",
      eligible: null,
      completed: page.items.length,
      queued: 0,
      chunks: page.load.revision,
      messages: 0,
      activeMs: 0,
      started: list.started,
      advanced: page.items.length ? Date.now() : list.started,
      wait: "waiting for native data",
    });
    const revision = list.revision;
    const replacing = !!list.replacement;
    if (page.load.state === "loading" && !page.items.length) {
      changed();
      return;
    }
    if (list.replacement) {
      if (page.load.state !== "complete") return;
      const replacement = list.replacement;
      replacement.generation = page.load.generation;
      replacement.items = pending.before
        ? [...replacement.items, ...page.items]
        : page.items;
      replacement.older = page.older;
      if (replacement.items.length < replacement.goal && replacement.older) {
        return;
      }
      page = { ...page, items: replacement.items };
      list.replacement = undefined;
    }
    list.generation = page.load.generation;
    const values = new Map(
      (pending.before && !replacing ? list.items : []).map((
        item,
      ) => [item.id, item]),
    );
    for (const item of page.items) values.set(item.id, item);
    list.items = [...values.values()];
    list.structures = list.items;
    list.older = page.older;
    list.ready = true;
    list.loading = page.load.state !== "complete";
    if (page.load.state === "complete") list.covered = true;
    changed();
    const context = async () => {
      const entries = new Map(list.items.map((item) => [item.id, item]));
      const seen = new Set(entries.keys());
      for (const item of entries.values()) {
        const parent = item.parentID;
        if (!parent || seen.has(parent)) continue;
        seen.add(parent);
        const info = await rpc.call(
          "session.get",
          { sessionID: parent },
          pending.abort.signal,
        );
        if (
          pending.abort.signal.aborted || list.revision !== revision ||
          list.items !== acquired
        ) return;
        if (info.directory !== list.input.directory) continue;
        entries.set(parent, {
          id: info.id,
          directory: info.directory,
          parentID: info.parentID,
          title: info.title,
        });
      }
      if (entries.size !== list.items.length) {
        list.structures = [...entries.values()];
        changed();
      }
    };
    const acquired = list.items;
    void context().catch((error) => {
      if (!pending.abort.signal.aborted) {
        console.warn("Session ancestry unavailable", error);
      }
    });
  };
  const read = (list: List, more = false) => {
    if (
      stopped || list.pending ||
      more && !(list.replacement?.older ?? list.older)
    ) return;
    if (!more) {
      list.replacement = list.covered && list.items.length
        ? { items: [], older: null, goal: list.items.length }
        : undefined;
    }
    const abort = new AbortController(), intent = rpc.intent();
    const pending = {
      intent,
      epoch: epoch(),
      abort,
      before: more ? (list.replacement?.older ?? list.older)! : undefined,
      revision: -1,
    };
    list.revision++;
    list.pending = pending;
    list.started = Date.now();
    progress.receive(sessionListKey(list.input), {
      generation: intent.key,
      phase: "reading",
      eligible: null,
      completed: 0,
      queued: 0,
      chunks: 0,
      messages: 0,
      activeMs: 0,
      started: list.started,
      advanced: list.started,
      wait: "waiting for native data",
    });
    list.loading = true;
    changed();
    void rpc.call("sessions.list", { ...list.input, before: pending.before }, {
      intent,
      signal: abort.signal,
    }).then((page) => {
      if (list.pending === pending && !abort.signal.aborted) apply(list, page);
    }).catch((error) => {
      if (!abort.signal.aborted) {
        console.warn("Session list unavailable", error);
      }
    }).finally(() => {
      if (list.pending === pending) {
        list.pending = undefined;
        changed();
        if (list.replacement?.older && list.active) {
          read(list, true);
        } else if (list.dirty && list.active) {
          list.dirty = false;
          read(list);
        } else advance(list);
      }
    });
  };
  const advance = (list: List) => {
    if (!list.active || list.loading || !list.older || list.pending) return;
    const visible = new Set(list.visible ?? []);
    if (list.items.slice(-5).some((item) => visible.has(item.id))) {
      read(list, true);
    }
  };
  return {
    get(input: SessionListInput): List {
      void store.state.revision;
      const key = sessionListKey(input);
      let list = lists.get(key);
      if (!list) {
        const previous = [...lists.values()].find((value) =>
          value.input.directory === input.directory &&
          value.input.parentID === input.parentID && value.ready
        );
        list = {
          input,
          items: previous?.items ?? [],
          structures: previous?.structures ?? [],
          older: null,
          ready: previous?.ready ?? false,
          loading: true,
          active: true,
          revision: 0,
          retained: new Map(),
          started: Date.now(),
        };
        lists.set(key, list);
        read(list);
      } else if (!list.active) {
        list.active = true;
        if (list.loading || !list.ready || list.dirty) {
          list.dirty = false;
          read(list);
        }
      }
      return list;
    },
    more: (list: List) => read(list, true),
    progress: (list: List) =>
      progress.display(sessionListKey(list.input), "Loading sessions"),
    structures(
      list: List,
      context: readonly (SessionStructure & { retained?: boolean })[],
    ) {
      const previous = projections.get(list);
      if (
        previous?.source === list.structures && previous.context === context
      ) return previous.value;
      for (const item of context) {
        if (item.retained) {
          list.retained.set(item.id, {
            id: item.id,
            directory: item.directory,
            title: item.title,
            parentID: item.parentID,
          });
        } else list.retained.delete(item.id);
      }
      const values = new Map(list.structures.map((item) => [item.id, item]));
      for (const item of list.retained.values()) values.set(item.id, item);
      for (const item of context) values.set(item.id, item);
      const value = [...values.values()];
      projections.set(list, { source: list.structures, context, value });
      return value;
    },
    viewport(list: List, keys: readonly string[]) {
      list.visible = keys;
      advance(list);
    },
    activate(input: SessionListInput) {
      for (const list of lists.values()) {
        if (
          list.input.directory === input.directory &&
          (list.input.query ?? "") === (input.query ?? "")
        ) continue;
        list.active = false;
        progress.reset(sessionListKey(list.input));
        list.pending?.abort.abort();
        list.pending = undefined;
      }
    },
    receive(frame: ServerFrame) {
      if (frame.t === "sessions.changed") {
        for (const list of lists.values()) {
          if (list.input.directory !== frame.directory) {
            continue;
          }
          list.dirty = true;
          if (!list.active) continue;
          queueMicrotask(() => {
            if (list.active && list.dirty && !list.pending && !stopped) {
              list.dirty = false;
              read(list);
            }
          });
        }
        return;
      }
      if (frame.t !== "load.chunk" || frame.data.kind !== "session-list") {
        return;
      }
      for (const list of lists.values()) {
        if (!list.active) continue;
        const pending = list.pending;
        if (
          !pending || frame.epoch !== pending.epoch ||
          frame.request.key !== pending.intent.key ||
          frame.request.clientID !== pending.intent.clientID ||
          frame.request.window !== pending.intent.window
        ) continue;
        if (frame.load.revision <= pending.revision) continue;
        if (frame.data.offset === 0) pending.chunks = [];
        if (frame.data.offset !== (pending.chunks?.length ?? 0)) continue;
        pending.chunks ??= [];
        pending.chunks.push(...frame.data.items);
        apply(list, {
          items: pending.chunks,
          older: frame.data.older,
          load: frame.load,
        });
      }
    },
    refresh() {
      for (const list of lists.values()) {
        if (!list.active) continue;
        list.pending?.abort.abort();
        list.pending = undefined;
        read(list);
      }
    },
    stop() {
      stopped = true;
      progress.stop();
      for (const list of lists.values()) list.pending?.abort.abort();
      lists.clear();
    },
  };
}
