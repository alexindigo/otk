// SPDX-License-Identifier: LGPL-3.0-only
import type { PublicFailure, RevertInfo } from "@otk/protocol";
import { failureText } from "./failure-features.ts";
import { RequestFailure } from "./failures.ts";
import type { SessionActions } from "./session-actions.ts";
import type { ClientSession, Selection } from "./session.ts";
import type { ContentState } from "./reduce.ts";
import { createState, type StateFactory } from "./state.ts";
import type { Drafts } from "./drafts.ts";
import { historyDraft } from "./prompt-history.ts";

export interface RevertStrip {
  count: number;
  preview: string;
  prompts: NonNullable<RevertInfo["prompts"]>;
  more: number;
  files: RevertInfo["files"];
}
type RevertIntent = "revert" | "code" | "restore" | "undo" | "redo";
export interface SessionRevertState {
  pending?: RevertIntent;
  error?: string;
  key?: string;
  failure?: PublicFailure;
}
export interface SessionRevert {
  readonly state: SessionRevertState;
  matches(target: Selection): boolean;
  revertTo(messageID: string, code?: boolean): Promise<void>;
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
  actions:
    & Pick<SessionActions, "revert" | "restore" | "abort">
    & Partial<Pick<SessionActions, "group">>;
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
  let operation: AbortController | undefined;
  const reset = () => {
    generation++;
    operation?.abort();
    operation = undefined;
    pending = false;
    store.update((state) => {
      state.pending = undefined;
      state.error = undefined;
      state.key = undefined;
      state.failure = undefined;
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
  ): Promise<void> => {
    signal.throwIfAborted();
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
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
      messageID = options.session.state.latestPrompt?.id;
    }
    if (
      (kind === "undo" || kind === "revert" || kind === "code") && !messageID
    ) return;
    const captured = { ...target }, current = generation;
    const group = options.actions.group?.(captured);
    const interrupt = group?.options("interrupt", captured.sessionID);
    const change = group?.options("boundary", captured.sessionID);
    const stopping = kind === "undo" && options.status.working(captured);
    const previousBoundary = options.session.state.content.revert?.messageID;
    const previousEpoch = options.session.state.clock?.epoch;
    const active = () => {
      observe();
      return alive && generation === current;
    };
    const draftKey = key;
    const transaction = kind === "undo" || kind === "revert" || kind === "code"
      ? options.drafts.reverts.capture(draftKey, previousBoundary)
      : undefined;
    const restoreDraft = options.drafts.reverts.restorer(
      draftKey,
      previousBoundary,
    );
    const controller = operation = new AbortController();
    pending = true;
    store.update((state) => {
      state.pending = kind;
      state.error = undefined;
      state.failure = undefined;
      state.key = (stopping ? interrupt : change)?.intent?.key;
    });
    try {
      if (stopping) {
        await options.actions.abort(captured, interrupt);
        if (!active()) return;
        await waitFor(
          () => !options.status.working(captured),
          options.status.subscribe,
          controller.signal,
        );
      }
      if (!active()) return;
      store.update((state) => {
        state.key = change?.intent?.key;
      });
      const result = kind === "revert" || kind === "undo" || kind === "code"
        ? await options.actions.revert(
          captured,
          messageID!,
          change,
          kind === "code",
        )
        : await options.actions.restore(captured, change);
      if (result.revert) transaction?.staged(result.revert.messageID);
      if (!active()) {
        // The native clear settled for its captured session, not the new view.
        // The draft owner fences both newer edits and replacement transactions.
        if ((kind === "restore" || kind === "redo") && !result.revert) {
          restoreDraft();
        }
        return;
      }
      // RPC completion admits the mutation. The selected transcript remains
      // authoritative, including a resync that is still reading its messages.
      const boundary = result.revert?.messageID;
      await waitFor(
        () => {
          const state = options.session.state;
          if (
            state.loading || state.continuity !== "ready" ||
            state.content.revert?.messageID !== boundary
          ) return false;
          if (
            boundary === previousBoundary && kind !== "code" &&
            JSON.stringify(state.content.revert?.files) ===
              JSON.stringify(result.revert?.files)
          ) return true;
          if (!state.clock || state.clock.epoch === previousEpoch) return false;
          return true;
        },
        (listener) => options.session.subscribe(listener),
        controller.signal,
      );
      if (!active()) return;
      const entry = result.revert?.prompt;
      if (kind === "undo" && entry) {
        transaction!.recall(historyDraft(entry));
      } else if ((kind === "redo" || kind === "restore") && !boundary) {
        restoreDraft();
      }
    } catch (error) {
      observe();
      if (alive && generation === current) {
        store.update((state) => {
          state.error = failureText(error);
          state.failure = error instanceof RequestFailure
            ? error.failure
            : undefined;
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
    revertTo: (id, code) => run(code ? "code" : "revert", id),
    restore: () => run("restore"),
    undo: () => run("undo"),
    redo: () => run("redo"),
    hasPrompt: () => !!options.session.state.latestPrompt,
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
