// SPDX-License-Identifier: LGPL-3.0-only
import {
  compareMessages,
  type Message,
  type PublicFailure,
  randomID,
  type RevertInfo,
} from "@otk/protocol";
import {
  errorFeedback,
  type FailureValue,
  failureValue,
} from "./failure-features.ts";
import { type Feedback, RequestFailure } from "./failures.ts";
import type { SessionActions } from "./session-actions.ts";
import type { ClientSession, Selection } from "./session.ts";
import type { ContentState } from "./reduce.ts";
import { createState, type StateFactory } from "./state.ts";
import type { Drafts } from "./drafts.ts";
import { historyDraft } from "./prompt-history.ts";
import { type BranchHistory, savedBranchMatches } from "./branch-history.ts";

export interface RevertStrip {
  boundaryID: string;
  messageIDs: string[];
  preview: string;
  files: RevertInfo["files"];
}
type RevertIntent = "revert" | "code" | "restore" | "undo" | "redo";
export type RevertPhase =
  | "idle"
  | "confirming"
  | "staging"
  | "staged"
  | "saving"
  | "saved"
  | "failed"
  | "restoring";
export interface SessionRevertState {
  phase?: RevertPhase;
  record?: RevertInfo;
  messages?: Message[];
  confirmation?: { kind: "revert" | "code" | "undo"; messageID: string };
  dismissed?: boolean;
  /** Explicit archive deletion keeps native staging, without recreating the copy. */
  copyRemoved?: boolean;
  pending?: RevertIntent;
  error?: FailureValue;
  key?: string;
  failure?: PublicFailure;
}
/** One projection for the rollback owner and its borrowed request feedback. */
export function revertPresentation(
  state: SessionRevertState,
  feedback?: Feedback,
  branchFailure?: FailureValue,
): { state: SessionRevertState; feedback?: Feedback } {
  const sameRequest = feedback?.identity && state.key === feedback.identity;
  const sameFailure = feedback?.diagnosticID &&
    state.failure?.diagnosticID === feedback.diagnosticID;
  const sameBranchFailure = branchFailure && branchFailure.diagnosticID &&
    feedback?.diagnosticID === branchFailure.diagnosticID;
  const ownsPending = sameRequest && state.pending &&
    feedback?.kind === "pending" && !feedback.failure;
  return {
    state,
    feedback: ownsPending || sameRequest || sameFailure || sameBranchFailure
      ? undefined
      : feedback,
  };
}
export interface SessionRevert {
  readonly state: SessionRevertState;
  matches(target: Selection): boolean;
  ready(target: Selection): Promise<void> | undefined;
  revertTo(messageID: string, code?: boolean): Promise<void>;
  confirm(): Promise<void>;
  cancel(): void;
  retry(): Promise<void>;
  dismiss(): void;
  restore(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  hasPrompt(): boolean;
  strip(content: ContentState): RevertStrip | undefined;
  dispose(): void;
}
/** One selected-session operation lifetime; server content is never optimistic. */
export function createSessionRevert(options: {
  session:
    & Pick<ClientSession, "state" | "subscribe">
    & Partial<Pick<ClientSession, "transcripts">>;
  actions:
    & Pick<SessionActions, "revert" | "restore" | "abort">
    & Partial<Pick<SessionActions, "group">>;
  drafts: Drafts;
  branchHistory?:
    & Pick<BranchHistory, "prepare" | "state">
    & Partial<
      Pick<
        BranchHistory,
        "subscribe" | "settled" | "preservationWarning" | "retryCopy"
      >
    >;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  server?(target: Selection): string;
  status: {
    working(target: Selection): boolean;
    subscribe(listener: () => void): () => void;
  };
  factory?: StateFactory;
}): SessionRevert {
  const store = (options.factory ?? createState)<SessionRevertState>({
    phase: "idle",
  });
  const flows = new Map<string, SessionRevertState>();
  const identity = () => {
    const t = options.session.state.selection;
    return t ? `${t.sidecarId}/${t.sessionID}` : "";
  };
  let key = identity(), generation = 0, pending = false, alive = true;
  let operation: AbortController | undefined;
  const settlements = new Map<string, Promise<void>>();
  const flow = () => flows.get(key) ?? { phase: "idle" as const };
  const publish = () =>
    store.update((state) => {
      for (const field of Object.keys(state)) {
        Reflect.deleteProperty(state, field);
      }
      Object.assign(state, flow());
      // Capture outcomes may arrive during native reconciliation. The active
      // mutation owns its phase until that publication wait has settled.
      if (state.pending) {
        state.phase = state.pending === "restore" || state.pending === "redo"
          ? "restoring"
          : "staging";
      }
    });
  const updateAt = (
    targetKey: string,
    change: (state: SessionRevertState) => void,
  ) => {
    const next = { ...flows.get(targetKey) };
    change(next);
    flows.set(targetKey, next);
    if (targetKey === key) publish();
  };
  const update = (change: (state: SessionRevertState) => void) =>
    updateAt(key, change);
  const dismissalKey = (target: Selection, boundaryID: string) =>
    "otk.revert-dismiss.v1/" +
    encodeURIComponent(
      JSON.stringify([
        options.server?.(target) ?? target.sidecarId,
        target.sessionID,
        boundaryID,
      ]),
    );
  const dismissed = (target: Selection, boundaryID: string) => {
    try {
      return options.storage?.getItem(dismissalKey(target, boundaryID)) ===
        "true";
    } catch {
      return false;
    }
  };
  const reset = () => {
    update((state) => {
      state.pending = undefined;
      state.key = undefined;
      if (state.phase === "staging" || state.phase === "restoring") {
        state.phase = state.record ? "staged" : "idle";
      }
    });
    generation++;
    operation?.abort();
    operation = undefined;
    pending = false;
  };
  const captures = new Map<string, Promise<void>>();
  const savedCopy = (
    record: RevertInfo,
    target = options.session.state.selection,
  ) => {
    const state = options.branchHistory?.state;
    if (
      state?.target &&
      (state.target.sidecarId !== target?.sidecarId ||
        state.target.sessionID !== target?.sessionID)
    ) return;
    return state?.branches.find((branch) => savedBranchMatches(branch, record));
  };
  const save = (target: Selection, record: RevertInfo): Promise<void> => {
    const capturedKey = `${target.sidecarId}/${target.sessionID}`;
    const captureKey = JSON.stringify([capturedKey, record.boundaryID]);
    const running = captures.get(captureKey);
    if (running) return running;
    if (!options.branchHistory) return Promise.resolve();
    if (options.branchHistory.preservationWarning?.()) return Promise.resolve();
    const completion = Promise.withResolvers<void>();
    captures.set(captureKey, completion.promise);
    updateAt(capturedKey, (state) => {
      state.phase = "saving";
      state.copyRemoved = undefined;
      state.error = undefined;
      state.failure = undefined;
    });
    void Promise.resolve().then(() =>
      options.branchHistory!.prepare(target, record.boundaryID, record)
    ).then(() => {
      updateAt(capturedKey, (state) => {
        if (state.record?.boundaryID !== record.boundaryID) return;
        if (key !== capturedKey) {
          state.phase = "staged";
          return;
        }
        const copy = savedCopy(record, target);
        state.phase = copy ? "saved" : "failed";
        if (!copy) {
          state.error = failureValue(
            new RequestFailure({
              code: "branch-history.missing",
              retry: "new-intent",
              diagnosticID: randomID(),
              facts: {
                actionLabel: "Saving the earlier conversation",
                target,
                reason: "The earlier conversation has not been saved.",
                recovery: "Retry, or Keep without a saved copy.",
              },
            }),
          );
        }
        if (copy) {
          state.messages = record.messageIDs.map((id) =>
            copy.messages.find((m) => m.id === id)!
          );
        }
      });
      completion.resolve();
    }, (cause) => {
      updateAt(capturedKey, (state) => {
        if (state.record?.boundaryID !== record.boundaryID) return;
        state.phase = "failed";
        state.error = failureValue(cause);
        state.failure = cause instanceof RequestFailure
          ? cause.failure
          : undefined;
      });
      completion.resolve();
    }).finally(() => {
      if (captures.get(captureKey) === completion.promise) {
        captures.delete(captureKey);
      }
    });
    return completion.promise;
  };
  const observe = () => {
    const next = identity();
    if (next !== key) {
      reset();
      key = next;
      publish();
    }
    if (!alive || pending) return;
    const target = options.session.state.selection;
    const record = options.session.state.content.revert;
    if (!target) return;
    if (!record) {
      if (
        flow().record && options.session.state.continuity === "ready" &&
        !options.session.state.loading
      ) {
        const restored = options.session.state.content.messages.some((m) =>
          m.id === flow().record?.boundaryID
        );
        flows.set(key, { phase: "idle" });
        publish();
        void options.branchHistory?.settled?.(target, restored).catch(() => {});
      }
      return;
    }
    if (flow().record?.boundaryID !== record.boundaryID) {
      update((state) => {
        state.record = record;
        state.phase = "staged";
        state.confirmation = undefined;
        state.error = undefined;
        state.failure = undefined;
        state.dismissed = dismissed(target, record.boundaryID);
        state.copyRemoved = undefined;
        state.messages = options.session.state.content.messages.filter((m) =>
          record.messageIDs.includes(m.id)
        );
      });
    }
    const copy = savedCopy(record);
    const candidate = options.branchHistory?.state;
    const history = !candidate?.target ||
        candidate.target.sidecarId === target.sidecarId &&
          candidate.target.sessionID === target.sessionID
      ? candidate
      : undefined;
    if (history?.recovery?.boundaryID === record.boundaryID && !copy) {
      update((state) => {
        state.phase = history.pending ? "saving" : "failed";
        state.error = history.error;
        state.failure = errorFeedback(history.error)?.failure?.value;
      });
      return;
    }
    if (
      !copy && flow().failure?.code.startsWith("branch-history.") &&
      !history?.error
    ) {
      update((state) => {
        state.phase = "staged";
        state.copyRemoved = true;
        state.error = undefined;
        state.failure = undefined;
      });
    }
    if (copy && flow().phase !== "restoring") {
      update((state) => {
        state.phase = "saved";
        state.messages = record.messageIDs.map((id) =>
          copy.messages.find((m) => m.id === id)!
        );
      });
    } else if (flow().phase === "saved") {
      update((state) => {
        state.phase = "staged";
        state.copyRemoved = true;
      });
    } else if (
      flow().phase === "staged" &&
      !flow().copyRemoved &&
      options.session.state.continuity === "ready" &&
      !options.session.state.loading
    ) {
      void save({ ...target }, record);
    }
  };
  const release = options.session.subscribe(observe);
  const releaseHistory = options.branchHistory?.subscribe?.(observe);
  const candidates = () => {
    const state = flow();
    const retained = state.record
      ? savedCopy(state.record)?.messages ?? state.messages ?? []
      : [];
    return [
      ...new Map(
        [...options.session.state.content.messages, ...retained].map((
          m,
        ) => [m.id, m]),
      ).values(),
    ].sort(compareMessages);
  };
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
    if (kind === "undo" && !messageID) {
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
    const previousBoundary = options.session.state.content.revert?.boundaryID;
    const previousEpoch = options.session.state.clock?.epoch;
    const active = () => {
      observe();
      return alive && generation === current;
    };
    const draftKey = key;
    const settled = Promise.withResolvers<void>();
    settlements.set(draftKey, settled.promise);
    const transaction = kind === "undo" || kind === "revert" || kind === "code"
      ? options.drafts.reverts.capture(draftKey, previousBoundary)
      : undefined;
    const restoreDraft = options.drafts.reverts.restorer(
      draftKey,
      previousBoundary,
    );
    const controller = operation = new AbortController();
    let nativeCleared = false;
    pending = true;
    update((state) => {
      state.pending = kind;
      state.phase = kind === "restore" || kind === "redo"
        ? "restoring"
        : "staging";
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
      update((state) => {
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
      if (result.revert) transaction?.staged(result.revert.boundaryID);
      nativeCleared = (kind === "restore" || kind === "redo") && !result.revert;
      if (!active()) return;
      if (result.revert) {
        update((state) => {
          state.record = result.revert;
          state.dismissed = dismissed(captured, result.revert!.boundaryID);
        });
      }
      // RPC completion admits the mutation. The selected transcript remains
      // authoritative, including a resync that is still reading its messages.
      const boundary = result.revert?.boundaryID;
      await waitFor(
        () => {
          const state = options.session.state;
          if (
            state.loading || state.continuity !== "ready" ||
            state.content.revert?.boundaryID !== boundary
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
      if (transaction && entry) {
        transaction!.recall(historyDraft(entry));
      }
      update((state) => {
        state.phase = result.revert ? "staged" : "idle";
        state.confirmation = undefined;
      });
    } catch (error) {
      observe();
      if (alive && generation === current) {
        update((state) => {
          state.phase = "failed";
          state.error = failureValue(error);
          state.failure = error instanceof RequestFailure
            ? error.failure
            : undefined;
        });
      }
    } finally {
      // Confirmed mutation settlement outlives the selected view's publication
      // wait. The captured restorer fences newer edits and replacement revisions.
      if (nativeCleared) restoreDraft();
      observe();
      if (alive && generation === current) {
        pending = false;
        operation = undefined;
        update((state) => {
          state.pending = undefined;
        });
        observe();
      }
      if (settlements.get(draftKey) === settled.promise) {
        settlements.delete(draftKey);
      }
      settled.resolve();
    }
  };
  const request = async (
    kind: "revert" | "code" | "undo",
    messageID?: string,
  ) => {
    observe();
    if (!alive || pending || !options.session.state.selection || !messageID) {
      return;
    }
    const target = { ...options.session.state.selection },
      capturedGeneration = generation;
    const transcript = options.session.transcripts?.get(target);
    if (transcript && !candidates().some((m) => m.id === messageID)) {
      await transcript.ensure(messageID);
      if (!alive || generation !== capturedGeneration) return;
    }
    const messages = candidates();
    const at = messages.findIndex((message) => message.id === messageID);
    update((state) => {
      state.phase = "confirming";
      state.confirmation = { kind, messageID };
      state.messages = at < 0
        ? []
        : JSON.parse(JSON.stringify(messages.slice(at)));
      state.error = undefined;
      state.failure = undefined;
    });
  };
  observe();
  return {
    state: store.state,
    ready: (target) =>
      settlements.get(`${target.sidecarId}/${target.sessionID}`),
    matches: (target) => {
      const selected = options.session.state.selection;
      return !!selected && selected.sidecarId === target.sidecarId &&
        selected.sessionID === target.sessionID;
    },
    revertTo: (id, code) => request(code ? "code" : "revert", id),
    async confirm() {
      const confirmation = flow().confirmation;
      if (!confirmation || pending) return;
      const messages = candidates();
      const at = messages.findIndex((message) =>
        message.id === confirmation.messageID
      );
      const current = at < 0 ? [] : messages.slice(at);
      if (
        JSON.stringify(current.map((m) => m.id)) !==
          JSON.stringify(flow().messages?.map((m) => m.id))
      ) {
        update((state) => {
          state.messages = JSON.parse(JSON.stringify(current));
        });
        return;
      }
      await run(confirmation.kind, confirmation.messageID);
    },
    cancel() {
      if (pending) return;
      update((state) => {
        state.confirmation = undefined;
        state.phase = state.record ? "staged" : "idle";
        state.messages = state.record ? state.messages : undefined;
        state.error = undefined;
        state.failure = undefined;
      });
      observe();
    },
    retry() {
      return options.branchHistory?.retryCopy?.().catch(() => {
        // The branch-history owner publishes the failure for both surfaces.
      }) ?? Promise.resolve();
    },
    dismiss() {
      const target = options.session.state.selection, record = flow().record;
      if (!target || !record) return;
      update((state) => {
        state.dismissed = true;
      });
      try {
        options.storage?.setItem(
          dismissalKey(target, record.boundaryID),
          "true",
        );
      } catch {
        update((state) => {
          state.error = failureValue(
            new RequestFailure({
              code: "revert.dismiss-storage",
              retry: "new-intent",
              diagnosticID: randomID(),
              facts: {
                actionLabel: "Saving the revert display choice",
                target: {
                  sidecarId: target.sidecarId,
                  sessionID: target.sessionID,
                },
                reason: "This browser could not save the dismissal.",
                recovery:
                  "Restore browser storage access, then dismiss it again to keep the choice after reload.",
              },
            }),
          );
        });
      }
    },
    restore: () => run("restore"),
    undo: () => request("undo", options.session.state.latestPrompt?.id),
    redo: () => run("redo"),
    hasPrompt: () => !!options.session.state.latestPrompt,
    strip(content) {
      const revert = content.revert;
      if (!revert) return;
      return {
        boundaryID: revert.boundaryID,
        messageIDs: revert.messageIDs,
        preview: revert.prompt?.input.split("\n")[0] ?? revert.boundaryID,
        files: revert.files,
      };
    },
    dispose() {
      alive = false;
      release();
      releaseHistory?.();
      reset();
    },
  };
}
