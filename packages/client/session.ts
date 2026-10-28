// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClockedContent,
  type ContentClock,
  errorMessage,
  isSessionID,
  type LatestPrompt,
  type MessageCursor,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { ContentOp, ContentSession, Message, Part } from "@otk/protocol";
import { isAttentionOp } from "@otk/protocol";
import { belongsToSession } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
import { type ContentState, emptyContent, reduce } from "./reduce.ts";
import {
  createModelCatalog,
  type ModelCatalogConnection,
  type ModelCatalogOwner,
} from "./model-catalog.ts";
import { createSessionUsage, type SessionUsageOwner } from "./session-usage.ts";

export interface Selection {
  sidecarId: string;
  sessionID: string;
  rootID?: string;
}
export function route(hash: string): Selection | undefined {
  const parts = hash.match(/^#\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (!parts) return;
  try {
    const sessionID = decodeURIComponent(parts[3] || parts[2]);
    const rootID = parts[3] ? decodeURIComponent(parts[2]) : undefined;
    if (
      !isSessionID(sessionID) || (rootID !== undefined && !isSessionID(rootID))
    ) return;
    return {
      sidecarId: decodeURIComponent(parts[1]),
      sessionID,
      ...(rootID ? { rootID } : {}),
    };
  } catch {
    return;
  }
}
export function hashFor(selection: Selection): string {
  return `#/${encodeURIComponent(selection.sidecarId)}/${
    selection.rootID ? encodeURIComponent(selection.rootID) + "/" : ""
  }${encodeURIComponent(selection.sessionID)}`;
}
export interface SessionState {
  view?: "content" | "deleted";
  catalogReady?: boolean;
  deleted?: IndexEntry;
  selection?: Selection;
  info?: ContentSession;
  clock?: ContentClock;
  latestPrompt?: LatestPrompt;
  siblings: ContentSession[];
  content: ContentState;
  loading: boolean;
  paging: boolean;
  exhausted: boolean;
  /** Missing baselines retain live operations until a successful recovery. */
  continuity: "loading" | "ready" | "missing";
  error?: string;
}
export type ToolPart = Extract<Part, { kind: "tool" }>;
export type ToolCompletionSource = (
  listener: (part: ToolPart) => void,
) => () => void;
export interface ClientSession {
  state: SessionState;
  /** One catalog for the selected session/directory, borrowed by its consumers. */
  readonly models: ModelCatalogOwner | undefined;
  readonly usage: SessionUsageOwner;
  subscribe(listener: (state: SessionState) => void): () => void;
  /** Live completions in this open lifetime; snapshots/paging are silent. */
  onToolCompleted(
    selection: Selection,
    listener: (part: ToolPart) => void,
  ): () => void;
  open(selection?: Selection): void;
  refetch(): Promise<void>;
  receive(sidecarId: string, frame: ServerFrame): void;
  removeServer(sidecarId: string): void;
  older(): Promise<void>;
  latestPrompt(): LatestPrompt | undefined;
  stop(): void;
}
export function createSession(
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
  factory: StateFactory = createState,
  catalogConnection?: (selection: Selection) => ModelCatalogConnection,
  waitForIndex = false,
): ClientSession {
  const { state, update: setState, subscribe } = factory<SessionState>({
    content: emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: false,
    continuity: "ready",
    view: "content",
  });
  let selected: Selection | undefined, generation = 0, load = 0;
  let view: "content" | "deleted" = "content";
  const usage = createSessionUsage(
    connection,
    factory,
    (target) => entry(target.sidecarId, target.sessionID),
  );
  const indexed = new Set<string>();
  let subscribed = false;
  let buffer: ClockedContent[] = [], bufferBytes = 0, fetching = false;
  let clock: ContentClock | undefined, cursor: MessageCursor | null = null;
  let missing = false, retry: ReturnType<typeof setTimeout> | undefined;
  let hasBaseline = false;
  let attentionReads: {
    events: Map<string, ContentOp>;
    bytes: number;
    count: number;
    pending: Set<"permission" | "question">;
  } | undefined;
  let controller: AbortController | undefined;
  let models: ModelCatalogOwner | undefined, catalogVersion = 0;
  // IDs only: the selected transcript remains the sole owner of part data.
  const completed = new Set<string>(), liveCompleted = new Set<string>();
  const toolListeners = new Set<{
    generation: number;
    delivered: Set<string>;
    listener: (part: ToolPart) => void;
  }>();
  const deliverTool = (part: ToolPart) => {
    for (const observer of toolListeners) {
      if (
        observer.generation !== generation || observer.delivered.has(part.id)
      ) continue;
      observer.delivered.add(part.id);
      observer.listener(part);
    }
  };
  const notePart = (part: Part, live: boolean) => {
    if (
      part.kind !== "tool" || part.call.status !== "completed" ||
      completed.has(part.id)
    ) return;
    completed.add(part.id);
    if (live) {
      liveCompleted.add(part.id);
      deliverTool(part);
    }
  };
  const baseline = (messages: Message[]) => {
    for (const message of messages) {
      for (const part of message.parts) notePart(part, false);
    }
  };
  const current = (id: number, request: number) =>
    id === generation && request === load;
  const schedule = () => {
    if (retry !== undefined || !selected) return;
    const policy = connection(selected.sidecarId).messages;
    if (!policy) return;
    const id = generation;
    retry = setTimeout(() => {
      retry = undefined;
      if (selected && id === generation) void refetch();
    }, policy.retryms);
  };
  const invalidate = () => {
    missing = true;
    buffer = [];
    bufferBytes = 0;
    load++;
    controller?.abort();
    fetching = false;
    attentionReads = undefined;
    setState((draft) => {
      draft.loading = false;
      draft.paging = false;
      draft.continuity = "missing";
    });
    schedule();
  };
  const accept = (frame: ClockedContent): boolean => {
    if (!clock || frame.clock.epoch !== clock.epoch) return false;
    if (frame.clock.seq <= clock.seq) return true;
    if (frame.clock.seq !== clock.seq + 1) return false;
    clock = frame.clock;
    return true;
  };
  const refetch = async () => {
    if (!selected) return;
    if (!connection(selected.sidecarId).messages) return;
    clearTimeout(retry);
    retry = undefined;
    if (entry(selected.sidecarId, selected.sessionID)?.deleted) {
      return;
    }
    if (
      waitForIndex && !indexed.has(selected.sidecarId) &&
      !entry(selected.sidecarId, selected.sessionID)
    ) return;
    const recovering = missing;
    const target = selected, id = generation, request = ++load;
    controller?.abort();
    const abort = controller = new AbortController();
    fetching = true;
    buffer = [];
    bufferBytes = 0;
    missing = false;
    const attention = attentionReads = {
      events: new Map<string, ContentOp>(),
      bytes: 0,
      count: 0,
      pending: new Set<"permission" | "question">(["permission", "question"]),
    };
    setState((draft) => {
      draft.loading = true;
      draft.paging = false;
      draft.continuity = recovering
        ? "missing"
        : hasBaseline
        ? "ready"
        : "loading";
      draft.error = undefined;
      draft.exhausted = false;
    });
    try {
      const sidecar = connection(target.sidecarId), rpc = sidecar.rpc;
      models?.connect();
      const diagnostic = (error: unknown) => {
        if (current(id, request)) {
          setState((draft) => {
            draft.error = errorMessage(error);
          });
        }
      };
      const optional = async (kind: "permission" | "question") => {
        try {
          if (kind === "permission") {
            const permissions = sidecar.supports("permissions")
              ? await rpc.call("permission.list", {
                sessionID: target.sessionID,
              }, abort.signal)
              : [];
            if (!current(id, request)) return;
            setState((draft) => {
              let content = { ...draft.content, permissions };
              for (const op of attention.events.values()) {
                if (
                  op.op === "permission.upsert" || op.op === "permission.remove"
                ) content = reduce(content, op);
              }
              draft.content = content;
            });
          } else {
            const questions = sidecar.supports("questions")
              ? await rpc.call(
                "question.list",
                { sessionID: target.sessionID },
                abort.signal,
              )
              : [];
            if (!current(id, request)) return;
            setState((draft) => {
              let content = { ...draft.content, questions };
              for (const op of attention.events.values()) {
                if (
                  op.op === "question.upsert" || op.op === "question.remove"
                ) content = reduce(content, op);
              }
              draft.content = content;
            });
          }
        } catch (error) {
          diagnostic(error);
        } finally {
          attention.pending.delete(kind);
          if (!attention.pending.size && attentionReads === attention) {
            attentionReads = undefined;
          }
        }
      };
      void optional("permission");
      void optional("question");
      const page = await rpc.call("session.messages", {
        sessionID: target.sessionID,
      }, abort.signal);
      const info = page.session, messages = page.items;
      if (!current(id, request)) return;
      if (
        page.sessionID !== target.sessionID ||
        page.from.epoch !== page.clock.epoch || page.from.seq > page.clock.seq
      ) throw new Error("Invalid message baseline");
      let nextClock = page.clock;
      const replay: ClockedContent[] = [];
      for (const frame of buffer) {
        if (frame.clock.epoch !== page.clock.epoch) {
          throw new Error("Message epoch changed during baseline");
        }
        if (frame.clock.seq <= nextClock.seq) continue;
        if (frame.clock.seq !== nextClock.seq + 1) {
          throw new Error("Message baseline has a gap");
        }
        nextClock = frame.clock;
        replay.push(frame);
      }
      clock = nextClock;
      cursor = page.older;
      if (info.parentID) {
        void rpc.call(
          "session.children",
          { sessionID: info.parentID },
          abort.signal,
        ).then((siblings) => {
          if (current(id, request)) {
            setState((draft) => {
              draft.siblings = siblings;
            });
          }
        }).catch(diagnostic);
      } else {setState((draft) => {
          draft.siblings = [];
        });}
      baseline(messages);
      buffer = [];
      bufferBytes = 0;
      fetching = false;
      hasBaseline = true;
      setState((draft) => {
        let content: ContentState = {
          ...draft.content,
          messages,
          revert: info.revert || null,
          error: info.error,
          errorState: info.errorState,
        };
        let latestPrompt = page.prompt;
        for (const { event } of page.catchup) content = reduce(content, event);
        for (const { event } of replay) {
          content = reduce(content, event);
          if (event.op === "message.upsert" && event.message.role === "user") {
            const message = event.message;
            latestPrompt = {
              id: message.id,
              agent: message.agent,
              model: message.model,
              variant: message.variant,
            };
          }
        }
        draft.info = info;
        draft.clock = clock;
        draft.latestPrompt = latestPrompt;
        draft.content = content;
        draft.loading = false;
        draft.continuity = "ready";
        draft.exhausted = page.older === null;
      });
    } catch (error) {
      if (!current(id, request)) return;
      buffer = [];
      bufferBytes = 0;
      fetching = false;
      missing = true;
      setState((draft) => {
        draft.loading = false;
        draft.continuity = "missing";
        draft.error = errorMessage(error);
      });
      schedule();
    }
  };
  const open = (
    selection?: Selection,
    force = false,
  ) => {
    if (
      selection?.sidecarId === selected?.sidecarId &&
      selection?.sessionID === selected?.sessionID
    ) { if (!force) return; }
    generation++;
    clearTimeout(retry);
    retry = undefined;
    load++;
    controller?.abort();
    models?.dispose();
    models = undefined;
    if (selected && subscribed) {
      connection(selected.sidecarId).subscribe(selected.sessionID, false);
    }
    subscribed = false;
    selected = selection;
    const deleted = selection &&
      entry(selection.sidecarId, selection.sessionID);
    const nextView = deleted?.deleted ? "deleted" : "content";
    view = nextView;
    if (
      selection && !deleted?.deleted &&
      (!waitForIndex || indexed.has(selection.sidecarId) || deleted)
    ) {
      const target = { ...selection }, sidecar = connection(target.sidecarId);
      models = createModelCatalog({
        connection: () =>
          catalogConnection?.(target) ?? {
            key: catalogVersion,
            connected: sidecar.supports("models"),
            available: sidecar.supports("models"),
          },
        load: (signal) =>
          sidecar.rpc.call(
            "models.list",
            { sessionID: target.sessionID },
            signal,
          ),
        factory,
      });
    }
    completed.clear();
    liveCompleted.clear();
    buffer = [];
    bufferBytes = 0;
    clock = undefined;
    cursor = null;
    missing = false;
    fetching = false;
    hasBaseline = false;
    attentionReads = undefined;
    setState((draft) => {
      draft.selection = selection;
      draft.catalogReady = !selection || !waitForIndex ||
        indexed.has(selection.sidecarId) || !!deleted;
      draft.view = nextView;
      draft.deleted = deleted?.deleted ? deleted : undefined;
      draft.info = undefined;
      draft.clock = undefined;
      draft.latestPrompt = undefined;
      draft.siblings = [];
      draft.content = emptyContent();
      draft.loading = !!selection;
      draft.continuity = selection ? "loading" : "ready";
      draft.paging = false;
      draft.exhausted = false;
      draft.error = undefined;
      if (deleted?.deleted) {
        draft.info = {
          id: deleted.id,
          directory: deleted.directory,
          title: deleted.title,
          projectID: deleted.projectID,
          parentID: deleted.parentID,
          archived: deleted.archived,
          time: { created: deleted.timeCreated, updated: deleted.timeUpdated },
        };
        draft.loading = false;
        draft.continuity = "ready";
        draft.exhausted = true;
      }
    });
    if (selection && !deleted?.deleted) {
      if (waitForIndex && !indexed.has(selection.sidecarId) && !deleted) return;
      connection(selection.sidecarId).subscribe(selection.sessionID, true);
      subscribed = true;
      void refetch();
    }
  };
  return {
    state,
    usage,
    get models() {
      void state.selection;
      return models;
    },
    subscribe,
    onToolCompleted(selection, listener) {
      const observer = {
        generation: selected?.sidecarId === selection.sidecarId &&
            selected?.sessionID === selection.sessionID
          ? generation
          : -1,
        delivered: new Set<string>(),
        listener,
      };
      toolListeners.add(observer);
      // Prompt bindings may mount after initial loading. Replay only completion
      // edges received live since open, never already-completed history.
      for (const message of state.content.messages) {
        for (const part of message.parts) {
          if (part.kind === "tool" && liveCompleted.has(part.id)) {
            deliverTool(part);
          }
        }
      }
      return () => {
        toolListeners.delete(observer);
      };
    },
    open,
    refetch,
    latestPrompt: () => state.latestPrompt,
    receive(sidecarId: string, frame: ServerFrame): void {
      usage.receive(sidecarId, frame);
      if (frame.t === "welcome") indexed.delete(sidecarId);
      if (frame.t === "index.snapshot") indexed.add(sidecarId);
      if (!selected || selected.sidecarId !== sidecarId) return;
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        const known = entry(sidecarId, selected.sessionID);
        if (
          !!known?.deleted !== (view === "deleted") ||
          (!subscribed && view !== "deleted")
        ) open(selected, true);
        else if (known?.deleted) {
          setState((draft) => {
            draft.deleted = known;
          });
        }
        return;
      }
      if (view === "deleted") return;
      if (frame.t === "welcome" || frame.t === "resync") {
        if (frame.t === "welcome") catalogVersion++;
        models?.connect();
        if (frame.t === "resync") void models?.refresh();
        void refetch();
        return;
      }
      if (frame.t !== "content") return;
      if (isAttentionOp(frame.event)) {
        if (
          !belongsToSession(
            frame.sessionID,
            selected.sessionID,
            (id) => entry(sidecarId, id),
          )
        ) return;
      } else if (frame.sessionID !== selected.sessionID) return;
      if (frame.event.op === "part.upsert") notePart(frame.event.part, true);
      if (frame.event.op === "message.upsert") baseline([frame.event.message]);
      if (isAttentionOp(frame.event) && attentionReads) {
        const event = frame.event;
        const key = event.op === "permission.upsert"
          ? `permission:${event.request.id}`
          : event.op === "permission.remove"
          ? `permission:${event.requestID}`
          : event.op === "question.upsert"
          ? `question:${event.request.id}`
          : event.op === "question.remove"
          ? `question:${event.requestID}`
          : undefined;
        if (
          key &&
          attentionReads.pending.has(
            key.startsWith("permission:") ? "permission" : "question",
          )
        ) {
          const policy = connection(sidecarId).messages!;
          const bytes =
            new TextEncoder().encode(JSON.stringify(event)).byteLength;
          if (
            ++attentionReads.count > policy.replayops ||
            attentionReads.bytes + bytes > policy.replaybytes
          ) invalidate();
          else {
            attentionReads.bytes += bytes;
            attentionReads.events.set(key, event);
          }
        }
      }
      if (isAttentionOp(frame.event)) {
        setState((draft) => {
          draft.content = reduce(draft.content, frame.event);
        });
        return;
      }
      if (missing) return;
      if (!frame.clock) {
        invalidate();
        return;
      }
      if (fetching) {
        const policy = connection(sidecarId).messages!;
        const value = { clock: frame.clock, event: frame.event };
        const bytes =
          new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (
          buffer.length >= policy.replayops ||
          bufferBytes + bytes > policy.replaybytes
        ) {
          invalidate();
          return;
        }
        buffer.push(value);
        bufferBytes += bytes;
      } else {
        const duplicate = clock?.epoch === frame.clock.epoch &&
          frame.clock.seq <= clock.seq;
        if (!accept({ clock: frame.clock, event: frame.event })) {
          invalidate();
          return;
        }
        if (duplicate) return;
        try {
          setState((draft) => {
            draft.content = reduce(draft.content, frame.event);
            draft.clock = clock;
            if (
              frame.event.op === "message.upsert" &&
              frame.event.message.role === "user"
            ) {
              const message = frame.event.message;
              draft.latestPrompt = {
                id: message.id,
                agent: message.agent,
                model: message.model,
                variant: message.variant,
              };
            }
          });
        } catch {
          invalidate();
        }
      }
    },
    async older(): Promise<void> {
      if (
        !selected || state.loading || state.paging || state.exhausted ||
        cursor === null
      ) return;
      const target = selected,
        id = generation,
        request = load,
        before = cursor;
      setState((draft) => {
        draft.paging = true;
      });
      try {
        const page = await connection(target.sidecarId).rpc.call(
          "session.messages",
          { sessionID: target.sessionID, before },
          controller?.signal,
        );
        if (!current(id, request)) return;
        if (
          page.sessionID !== target.sessionID ||
          page.clock.epoch !== clock?.epoch
        ) {
          invalidate();
          return;
        }
        let loaded = { ...emptyContent(), messages: page.items };
        for (const { event } of page.catchup) loaded = reduce(loaded, event);
        const messages = loaded.messages;
        cursor = page.older;
        baseline(messages);
        setState((draft) => {
          const existing = new Set(draft.content.messages.map((m) => m.id));
          draft.content.messages.unshift(
            ...messages.filter((m) => !existing.has(m.id)),
          );
          draft.exhausted = page.older === null;
          draft.paging = false;
        });
      } catch (error) {
        if (current(id, request)) {
          setState((draft) => {
            draft.paging = false;
            draft.error = errorMessage(error);
          });
        }
      }
    },
    removeServer(sidecarId): void {
      indexed.delete(sidecarId);
      usage.removeServer(sidecarId);
      if (selected?.sidecarId === sidecarId) open();
    },
    stop(): void {
      open();
      usage.stop();
    },
  };
}
