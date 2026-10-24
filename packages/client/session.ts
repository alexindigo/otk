// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
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
    return {
      sidecarId: decodeURIComponent(parts[1]),
      sessionID: decodeURIComponent(parts[3] || parts[2]),
      ...(parts[3] ? { rootID: decodeURIComponent(parts[2]) } : {}),
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
  selection?: Selection;
  info?: ContentSession;
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
  older(): Promise<void>;
  stop(): void;
}
export function createSession(
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
  factory: StateFactory = createState,
  catalogConnection?: (selection: Selection) => ModelCatalogConnection,
): ClientSession {
  const { state, update: setState, subscribe } = factory<SessionState>({
    content: emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: false,
    continuity: "ready",
  });
  let selected: Selection | undefined, generation = 0, load = 0;
  const usage = createSessionUsage(connection, factory);
  let releaseUsage: (() => void) | undefined;
  let buffer: ContentOp[] = [], fetching = false;
  let hasBaseline = false;
  let attentionReads: {
    events: ContentOp[];
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
  const refetch = async () => {
    if (!selected) return;
    const target = selected, id = generation, request = ++load;
    controller?.abort();
    const abort = controller = new AbortController();
    fetching = true;
    const attention = attentionReads = {
      events: [] as ContentOp[],
      pending: new Set<"permission" | "question">(["permission", "question"]),
    };
    setState((draft) => {
      draft.loading = true;
      draft.paging = false;
      draft.continuity = hasBaseline ? "ready" : "loading";
      draft.error = undefined;
      draft.exhausted = false;
    });
    try {
      const sidecar = connection(target.sidecarId), rpc = sidecar.rpc;
      models?.connect();
      void usage.load(target);
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
              for (const op of attention.events) {
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
              for (const op of attention.events) {
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
      const [info, messages] = await Promise.all([
        rpc.call(
          "session.get",
          { sessionID: target.sessionID },
          abort.signal,
        ),
        rpc.call("session.messages", {
          sessionID: target.sessionID,
          limit: 100,
        }, abort.signal),
      ]);
      if (!current(id, request)) return;
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
      const replay = buffer;
      buffer = [];
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
        for (const op of replay) content = reduce(content, op);
        draft.info = info;
        draft.content = content;
        draft.loading = false;
        draft.continuity = "ready";
        draft.exhausted = messages.length < 100;
      });
    } catch (error) {
      if (!current(id, request)) return;
      const replay = hasBaseline ? buffer : [];
      if (hasBaseline) {
        buffer = [];
        fetching = false;
      }
      setState((draft) => {
        for (const op of replay) draft.content = reduce(draft.content, op);
        draft.loading = false;
        draft.continuity = hasBaseline ? "ready" : "missing";
        draft.error = errorMessage(error);
      });
    }
  };
  const open = (selection?: Selection) => {
    if (
      selection?.sidecarId === selected?.sidecarId &&
      selection?.sessionID === selected?.sessionID
    ) return;
    generation++;
    load++;
    controller?.abort();
    models?.dispose();
    models = undefined;
    releaseUsage?.();
    releaseUsage = undefined;
    if (selected) {
      connection(selected.sidecarId).subscribe(selected.sessionID, false);
    }
    selected = selection;
    if (selection) {
      const target = { ...selection }, sidecar = connection(target.sidecarId);
      releaseUsage = usage.retain(target);
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
    fetching = false;
    hasBaseline = false;
    attentionReads = undefined;
    setState((draft) => {
      draft.selection = selection;
      draft.info = undefined;
      draft.siblings = [];
      draft.content = emptyContent();
      draft.loading = !!selection;
      draft.continuity = selection ? "loading" : "ready";
      draft.paging = false;
      draft.exhausted = false;
      draft.error = undefined;
    });
    if (selection) {
      connection(selection.sidecarId).subscribe(selection.sessionID, true);
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
    receive(sidecarId: string, frame: ServerFrame): void {
      usage.receive(sidecarId, frame);
      if (!selected || selected.sidecarId !== sidecarId) return;
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
        attentionReads.events.push(frame.event);
      }
      if (fetching) buffer.push(frame.event);
      else {setState((draft) => {
          draft.content = reduce(draft.content, frame.event);
        });}
    },
    async older(): Promise<void> {
      if (
        !selected || state.loading || state.paging || state.exhausted ||
        !state.content.messages.length
      ) return;
      const target = selected,
        id = generation,
        request = load,
        first = state.content.messages[0].id;
      setState((draft) => {
        draft.paging = true;
      });
      try {
        const messages = await connection(target.sidecarId).rpc.call(
          "session.messages",
          { sessionID: target.sessionID, limit: 100, before: first },
          controller?.signal,
        );
        if (!current(id, request)) return;
        baseline(messages);
        setState((draft) => {
          const existing = new Set(draft.content.messages.map((m) => m.id));
          draft.content.messages.unshift(
            ...messages.filter((m) => !existing.has(m.id)),
          );
          draft.exhausted = messages.length < 100;
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
    stop(): void {
      open();
      usage.stop();
    },
  };
}
