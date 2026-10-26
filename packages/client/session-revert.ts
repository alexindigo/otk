// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage, type RevertInfo } from "@otk/protocol";
import type { SessionActions } from "./session-actions.ts";
import type { ClientSession, Selection } from "./session.ts";
import type { ContentState } from "./reduce.ts";
import { createState, type StateFactory } from "./state.ts";
import {
  clearDraft,
  type Draft,
  type Drafts,
  replaceDraftContent,
} from "./drafts.ts";
import { hasDraftContent } from "./draft-content.ts";
import { historyDraft } from "./prompt-history.ts";

export interface RevertStrip {
  count: number;
  preview: string;
  prompts: NonNullable<RevertInfo["prompts"]>;
  more: number;
  files: RevertInfo["files"];
}
type RevertIntent = "revert" | "restore" | "undo" | "redo";
export interface SessionRevertState {
  pending?: RevertIntent;
  error?: string;
}
export interface SessionRevert {
  readonly state: SessionRevertState;
  matches(target: Selection): boolean;
  revertTo(messageID: string): Promise<void>;
  restore(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  hasPrompt(): boolean;
  strip(content: ContentState): RevertStrip | undefined;
  dispose(): void;
}
/** One selected-session operation lifetime; server content is never optimistic. */
export function createSessionRevert(options: {
  session: Pick<ClientSession, "state" | "subscribe">;
  actions: Pick<SessionActions, "revert" | "restore" | "abort">;
  drafts: Drafts;
  status: {
    working(target: Selection): boolean;
    subscribe(listener: () => void): () => void;
  };
  factory?: StateFactory;
}): SessionRevert {
  const store = (options.factory ?? createState)<SessionRevertState>({});
  const identity = () => {
    const t = options.session.state.selection;
    return t ? `${t.sidecarId}/${t.sessionID}` : "";
  };
  let key = identity(), generation = 0, pending = false, alive = true;
  let written: Draft | undefined, operation: AbortController | undefined;
  const reset = () => {
    generation++;
    operation?.abort();
    operation = undefined;
    written = undefined;
    pending = false;
    store.update((state) => {
      state.pending = undefined;
      state.error = undefined;
    });
  };
  const observe = () => {
    const next = identity();
    if (next !== key) {
      key = next;
      reset();
    }
  };
  const release = options.session.subscribe(observe);
  const waitFor = (
    ready: () => boolean,
    subscribe: (listener: () => void) => () => void,
    signal: AbortSignal,
    timeout: number,
    message: string,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(signal.reason);
      const check = () => {
        if (ready()) finish();
      };
      const stop = subscribe(check);
      const timer = setTimeout(
        () => finish(new Error(message)),
        timeout,
      );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else check();
    });
  };
  const run = async (kind: RevertIntent, messageID?: string) => {
    observe();
    const target = options.session.state.selection;
    if (!alive || !target || pending) return;
    if (kind === "undo") {
      messageID = options.session.state.content.messages.findLast((message) =>
        message.role === "user"
      )?.id;
    }
    if ((kind === "undo" || kind === "revert") && !messageID) return;
    const captured = { ...target }, current = generation;
    const previousBoundary = options.session.state.content.revert?.messageID;
    const previousMessages = new Set(
      options.session.state.content.messages.map((message) => message.id),
    );
    const active = () => {
      observe();
      return alive && generation === current;
    };
    const write = kind === "undo" || kind === "redo"
      ? options.drafts.writer(key)
      : undefined;
    const controller = operation = new AbortController();
    pending = true;
    store.update((state) => {
      state.pending = kind;
      state.error = undefined;
    });
    try {
      if (kind === "undo" && options.status.working(captured)) {
        await options.actions.abort(captured);
        if (!active()) return;
        await waitFor(
          () => !options.status.working(captured),
          options.status.subscribe,
          controller.signal,
          10_000,
          "The session is still stopping. Try Undo again.",
        );
      }
      if (!active()) return;
      const result = kind === "revert" || kind === "undo"
        ? await options.actions.revert(captured, messageID!)
        : await options.actions.restore(captured);
      if (!active()) return;
      // RPC completion admits the mutation. The selected transcript remains
      // authoritative, including a resync that is still reading its messages.
      const boundary = result.revert?.messageID;
      await waitFor(
        () => {
          const state = options.session.state;
          if (
            state.loading || state.content.revert?.messageID !== boundary
          ) return false;
          if (boundary) {
            return !state.content.messages.some((message) =>
              message.id === boundary
            );
          }
          return !previousBoundary ||
            state.content.messages.some((message) =>
              !previousMessages.has(message.id)
            );
        },
        (listener) => options.session.subscribe(listener),
        controller.signal,
        30_000,
        "The session is still updating. Try again.",
      );
      if (!active()) return;
      const entry = result.revert?.prompt;
      if (kind === "undo" && entry) {
        write!((draft) => {
          if (draft === written || (!hasDraftContent(draft) && !draft.editor)) {
            written = replaceDraftContent(draft, historyDraft(entry));
            return written;
          }
          return draft;
        });
      } else if (kind === "redo") {
        write!((draft) => draft === written ? clearDraft(draft) : draft);
        written = undefined;
      }
    } catch (error) {
      observe();
      if (alive && generation === current) {
        store.update((state) => {
          state.error = errorMessage(error);
        });
      }
    } finally {
      observe();
      if (alive && generation === current) {
        pending = false;
        operation = undefined;
        store.update((state) => {
          state.pending = undefined;
        });
      }
    }
  };
  return {
    state: store.state,
    matches: (target) => {
      const selected = options.session.state.selection;
      return !!selected && selected.sidecarId === target.sidecarId &&
        selected.sessionID === target.sessionID;
    },
    revertTo: (id) => run("revert", id),
    restore: () => run("restore"),
    undo: () => run("undo"),
    redo: () => run("redo"),
    hasPrompt: () =>
      options.session.state.content.messages.some((message) =>
        message.role === "user"
      ),
    strip(content) {
      const revert = content.revert;
      if (!revert) return;
      const prompts = revert.prompts ?? [];
      return {
        count: revert.messageCount,
        preview: prompts[0]?.preview ?? "",
        prompts,
        more: Math.max(0, revert.messageCount - prompts.length),
        files: revert.files,
      };
    },
    dispose() {
      alive = false;
      release();
      reset();
    },
  };
}
