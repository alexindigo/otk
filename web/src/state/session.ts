// SPDX-License-Identifier: LGPL-3.0-only
import { createStore } from "solid-js";
import type {
  ContentOp,
  ContentSession,
  Message,
  PermissionRequest,
} from "../../../protocol/content.ts";
import { isPermissionOp } from "../../../protocol/content.ts";
import { belongsToSession } from "../../../protocol/session-tree.ts";
import type { IndexEntry } from "../../../protocol/index.ts";
import type { ServerFrame } from "../../../protocol/messages.ts";
import type { SidecarConnection } from "../net/sidecar.ts";
import { type ContentState, emptyContent, reduce } from "./reduce.ts";

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
export function createSession(
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
) {
  const [state, setState] = createStore<
    {
      selection?: Selection;
      info?: ContentSession;
      siblings: ContentSession[];
      content: ContentState;
      loading: boolean;
      paging: boolean;
      exhausted: boolean;
      error?: string;
    }
  >({
    content: emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: false,
  });
  let selected: Selection | undefined, generation = 0, load = 0;
  let buffer: ContentOp[] = [], fetching = false;
  let controller: AbortController | undefined;
  const current = (id: number, request: number) =>
    id === generation && request === load;
  const refetch = async () => {
    if (!selected) return;
    const target = selected, id = generation, request = ++load;
    controller?.abort();
    const abort = controller = new AbortController();
    buffer = [];
    fetching = true;
    setState((draft) => {
      draft.loading = true;
      draft.error = undefined;
      draft.exhausted = false;
    });
    try {
      const rpc = connection(target.sidecarId).rpc;
      const [info, messages, permissions] = await Promise.all([
        rpc.call<ContentSession>(
          "session.get",
          { sessionID: target.sessionID },
          abort.signal,
        ),
        rpc.call<Message[]>("session.messages", {
          sessionID: target.sessionID,
          limit: 100,
        }, abort.signal),
        rpc.call<PermissionRequest[]>("permission.list", {
          sessionID: target.sessionID,
        }, abort.signal),
      ]);
      if (!current(id, request)) return;
      const siblings = info.parentID
        ? await rpc.call<ContentSession[]>("session.children", {
          sessionID: info.parentID,
        }, abort.signal)
        : [];
      if (!current(id, request)) return;
      let content = {
        ...emptyContent(),
        messages,
        permissions,
        revert: info.revert || null,
      };
      for (const op of buffer) content = reduce(content, op);
      buffer = [];
      fetching = false;
      setState((draft) => {
        draft.info = info;
        draft.siblings = siblings;
        draft.content = content;
        draft.loading = false;
        draft.exhausted = messages.length < 100;
      });
    } catch (error) {
      if (!current(id, request)) return;
      fetching = false;
      buffer = [];
      setState((draft) => {
        draft.loading = false;
        draft.error = (error as Error).message;
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
    if (selected) {
      connection(selected.sidecarId).subscribe(selected.sessionID, false);
    }
    selected = selection;
    buffer = [];
    fetching = false;
    setState((draft) => {
      draft.selection = selection;
      draft.info = undefined;
      draft.siblings = [];
      draft.content = emptyContent();
      draft.loading = !!selection;
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
    open,
    refetch,
    receive(sidecarId: string, frame: ServerFrame): void {
      if (!selected || selected.sidecarId !== sidecarId) return;
      if (frame.t === "welcome" || frame.t === "resync") {
        void refetch();
        return;
      }
      if (frame.t !== "content") return;
      if (isPermissionOp(frame.event)) {
        if (
          !belongsToSession(
            frame.sessionID,
            selected.sessionID,
            (id) => entry(sidecarId, id),
          )
        ) return;
      } else if (frame.sessionID !== selected.sessionID) return;
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
        const messages = await connection(target.sidecarId).rpc.call<Message[]>(
          "session.messages",
          { sessionID: target.sessionID, limit: 100, before: first },
          controller?.signal,
        );
        if (!current(id, request)) return;
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
            draft.error = (error as Error).message;
          });
        }
      }
    },
    stop(): void {
      open();
    },
  };
}
