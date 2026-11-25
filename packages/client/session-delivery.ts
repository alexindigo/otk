// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContentClock,
  randomID,
  type SubmissionReceipt,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import type { TranscriptOwner } from "./transcript.ts";
import type { Selection } from "./session.ts";
import {
  errorFeedback,
  failureValue,
  presentFailure,
} from "./failure-features.ts";
import type { Feedback } from "./failures.ts";
import { RequestFailure } from "./failures.ts";
import type { PendingSend } from "./pending-send.ts";
import { refusedSend, type SendOutcome } from "./send-outcome.ts";

/** This is an observation deadline, never a mutation timeout or permission to resend. */
export const SEND_OBSERVATION_MS = 10_000;
export interface DeliveryReceipt {
  id: string;
  messageID?: string;
  phase: "submitted" | "accepted" | "queued" | "admitted" | "presented";
  clock?: ContentClock;
  feedback?: Feedback;
  entry?: boolean;
  outcome?: SendOutcome;
  settled?: boolean;
}
export interface SendCustody {
  admit?(messageID: string, check: () => void): void;
  outcome(value: SendOutcome): void;
}
export interface SessionDelivery {
  readonly state: {
    receipts: readonly DeliveryReceipt[];
    follow: number;
    last?: DeliveryReceipt;
  };
  subscribe(listener: () => void): () => void;
  send(
    action: (dispatch: () => void) => Promise<SubmissionReceipt | null>,
    entry?: PendingSend,
    messageID?: string,
    custody?: SendCustody,
  ): Promise<SendOutcome>;
  /** Reattach receipt observation only; never replay the submission preparation. */
  resume(entry: PendingSend, result?: Promise<SubmissionReceipt | null>): void;
  /** The viewport reports real visible native sources through its existing port. */
  presented(ids: readonly string[]): void;
  reload(): Promise<void>;
  stop(): void;
}
/** Source-free submission receipts borrow the canonical projection and read owner. */
export function createSessionDelivery(input: {
  target: Selection;
  title(): string | undefined;
  transcript(): TranscriptOwner | undefined;
  /** The canonical native prompt once its applied model is known, never speculative input. */
  committed?(message: import("@otk/protocol").UserMessage): void;
  factory?: StateFactory;
  clock?: {
    set(run: () => void, ms: number): unknown;
    clear(timer: unknown): void;
  };
}): SessionDelivery {
  const store = createState({
    receipts: [] as DeliveryReceipt[],
    follow: 0,
    last: undefined as DeliveryReceipt | undefined,
  });
  const binding = (input.factory ?? createState)({ revision: 0 });
  const commit = (change: (state: typeof store.state) => void) => {
    store.update(change);
    binding.update((s) => {
      s.revision++;
    });
  };
  const clock = input.clock ??
    {
      set: (run: () => void, ms: number) => setTimeout(run, ms),
      clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
  const timers = new Map<string, unknown>(),
    pins = new Map<string, () => void>();
  const outcomes = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<SendOutcome>>
  >();
  // Receipts are for presentation and may disappear before native identity
  // resolves. Only the custody observer outlives that projection.
  const watches = new Map<
    string,
    { messageID: string; custody: SendCustody }
  >();
  const observe = (id: string, outcome: SendOutcome) => {
    const watch = watches.get(id);
    if (!watch) return;
    if (
      outcome.kind === "committed" || outcome.kind === "refused" ||
      outcome.kind === "failed" && outcome.certainty === "definite"
    ) watches.delete(id);
    watch.custody.outcome(outcome);
  };
  const finish = (id: string, outcome: SendOutcome) => {
    observe(id, outcome);
    const pending = outcomes.get(id);
    if (!pending) return;
    outcomes.delete(id);
    pending.resolve(outcome);
    update(id, (receipt) => receipt.outcome = outcome);
  };
  // Native queue/admission can precede applied selection metadata. Presentation
  // releases the visible receipt, not this identity-only bookkeeping obligation.
  const applied = new Set<string>();
  let transcript: TranscriptOwner | undefined,
    release: (() => void) | undefined,
    stopped = false;
  let visible = new Set<string>();
  const update = (id: string, change: (receipt: DeliveryReceipt) => void) =>
    commit((s) => {
      const receipt = s.receipts.find((r) => r.id === id);
      if (receipt) change(receipt);
    });
  const clear = (id: string) => {
    if (timers.has(id)) clock.clear(timers.get(id));
    timers.delete(id);
    pins.get(id)?.();
    pins.delete(id);
  };
  const committedMessage = (id: string) => {
    const message = transcript?.projection.state.messagesByID[id];
    return message?.sessionID === input.target.sessionID &&
        transcript?.projection.committed(id)
      ? message
      : undefined;
  };
  const inspect = () => {
    if (stopped) return;
    for (const [id, { messageID }] of watches) {
      if (committedMessage(messageID)) {
        observe(id, { kind: "committed", messageID });
      }
    }
    for (const receipt of [...store.state.receipts]) {
      if (!receipt.messageID || receipt.phase === "presented") continue;
      const message = committedMessage(receipt.messageID);
      if (!message) continue;
      if (receipt.phase !== "admitted") {
        update(receipt.id, (r) => {
          r.phase = "admitted";
          r.clock = transcript?.state.clock;
          r.feedback = undefined;
        });
        if (input.committed && message.role === "user") applied.add(message.id);
      }
      if (receipt.settled) {
        finish(receipt.id, { kind: "committed", messageID: message.id });
      }
      if (visible.has(receipt.messageID)) {
        if (receipt.settled) clear(receipt.id);
        commit((s) => {
          s.last = { ...receipt, phase: "presented", feedback: undefined };
          if (receipt.settled) {
            s.receipts = s.receipts.filter((r) => r.id !== receipt.id);
          }
        });
      }
    }
    for (const id of applied) {
      const message = committedMessage(id);
      if (
        message?.role !== "user" || !message.model
      ) continue;
      applied.delete(id);
      try {
        input.committed?.(message);
      } catch (cause) {
        console.error("Prompt admission bookkeeping diagnostic", cause);
      }
    }
  };
  const bind = () => {
    const next = input.transcript();
    if (next !== transcript) {
      release?.();
      transcript = next;
      release = next?.subscribe(inspect);
    }
    inspect();
  };
  const unavailable = (id: string) => {
    const current = store.state.receipts.find((receipt) => receipt.id === id);
    if (
      !current?.settled && current?.messageID &&
      committedMessage(current.messageID)
    ) {
      update(id, (receipt) => receipt.settled = true);
      inspect();
      return;
    }
    update(id, (receipt) => {
      if (receipt.phase === "presented") return;
      receipt.feedback = presentFailure({
        code: "send.observation",
        retry: "none",
        diagnosticID: receipt.id,
        facts: {
          actionLabel: "Sending prompt",
          target: { ...input.target, label: input.title() },
          ...(receipt.phase === "admitted"
            ? {}
            : { outcome: "unknown" as const }),
          reason: receipt.phase === "admitted"
            ? "The sent message was admitted, but its presentation has not been observed."
            : "The message has not been observed in opencode's transcript.",
          recovery:
            "Reload this session's latest messages. Do not send it again.",
        },
      }, { surface: "record", view: input.target });
    });
    const failure = store.state.receipts.find((receipt) => receipt.id === id)
      ?.feedback?.failure?.value;
    finish(id, {
      kind: "failed",
      certainty: "uncertain",
      reason: failure?.facts?.reason ??
        "The native message has not been observed.",
      retry: () => void owner.reload(),
      ...(failure ? { failure } : {}),
    });
  };
  const owner: SessionDelivery = {
    get state() {
      void binding.state.revision;
      return store.state;
    },
    subscribe: (listener) => store.subscribe(listener),
    resume(entry, result) {
      bind();
      if (!result && entry.dispatched === false) {
        transcript?.send?.({
          ...entry,
          phase: "failed",
          feedback: presentFailure({
            code: "send.not-submitted",
            retry: "new-intent",
            diagnosticID: entry.intent.key,
            facts: {
              actionLabel: "Sending prompt",
              target: { ...input.target, label: input.title() },
              reason: "The page reloaded before this message was sent.",
              recovery:
                "The message is retained here. Copy it to the composer to send it.",
            },
          }, { surface: "record", view: input.target }),
        });
        return;
      }
      const recovered = {
        ...entry,
        retry: () => {
          void owner.reload();
        },
      };
      const failure = entry.feedback?.failure?.value;
      void owner.send((dispatch) => {
        dispatch();
        return result ??
          (failure
            ? Promise.reject(new RequestFailure(failure))
            : Promise.resolve(null));
      }, recovered);
    },
    async send(action, entry, messageID, custody) {
      let activated: string | undefined;
      try {
        if (stopped) {
          return {
            kind: "refused",
            reason: "The submission owner is no longer active.",
          };
        }
        bind();
        const id = entry?.intent.key ?? randomID();
        activated = id;
        const currentEntry = () =>
          (entry && transcript?.projection.entry(entry.message.id)?.send) ??
            entry!;
        if (entry) {
          if (committedMessage(entry.message.id)) {
            return { kind: "committed", messageID: entry.message.id };
          }
          const previous = outcomes.get(id)?.promise ??
            store.state.receipts.find((receipt) => receipt.id === id)?.outcome;
          if (previous) return await previous;
        }
        const outcome = Promise.withResolvers<SendOutcome>();
        outcomes.set(id, outcome);
        commit((s) => {
          s.receipts.push({
            id,
            phase: "submitted",
            messageID: entry?.message.id ?? messageID,
            entry: !!entry,
          });
          s.follow++;
        });
        if (entry) {
          const publish = (value: PendingSend) => transcript?.send?.(value);
          const observeAgain = () => {
            publish({
              ...currentEntry(),
              phase: "pending",
              feedback: undefined,
            });
            timers.set(
              id,
              clock.set(() => failObservation(), SEND_OBSERVATION_MS),
            );
            void owner.reload();
          };
          const failObservation = () => {
            const receipt = store.state.receipts.find((r) => r.id === id);
            if (committedMessage(entry.message.id)) {
              update(id, (receipt) => receipt.settled = true);
              inspect();
              return;
            }
            if (
              !receipt || receipt.phase === "admitted" ||
              receipt.phase === "presented"
            ) return;
            const feedback = presentFailure({
              code: "send.observation",
              retry: "none",
              diagnosticID: id,
              facts: {
                actionLabel: "Sending prompt",
                outcome: "unknown",
                target: { ...input.target, label: input.title() },
                reason:
                  "The message has not been observed in opencode's transcript within ten seconds.",
                recovery:
                  "Retry checks the existing send without sending it again.",
              },
            }, { surface: "record", view: input.target });
            publish({
              ...currentEntry(),
              phase: "failed",
              feedback: feedback &&
                { ...feedback, action: { label: "Retry", run: observeAgain } },
              retry: observeAgain,
            });
            finish(id, {
              kind: "failed",
              certainty: "uncertain",
              reason: feedback?.failure?.reason ??
                "The native message has not been observed within ten seconds.",
              retry: observeAgain,
              ...(feedback?.failure ? { failure: feedback.failure.value } : {}),
            });
          };
          publish({ ...entry, dispatched: entry.dispatched ?? false });
          timers.set(id, clock.set(failObservation, SEND_OBSERVATION_MS));
        }
        void (async () => {
          let result: SubmissionReceipt | null;
          let dispatched = false;
          try {
            result = await action(() => {
              if (stopped) {
                throw new Error("The submission owner is no longer active.");
              }
              if (dispatched) return;
              const identity = entry?.message.id ?? messageID;
              if (identity && custody) {
                custody.admit?.(identity, () => void owner.reload());
                watches.set(id, { messageID: identity, custody });
              }
              dispatched = true;
              if (entry) {
                transcript?.send?.({ ...currentEntry(), dispatched: true });
              } else if (!timers.has(id)) {
                timers.set(
                  id,
                  clock.set(() => unavailable(id), SEND_OBSERVATION_MS),
                );
              }
            });
          } catch (cause) {
            if (stopped) return;
            clear(id);
            const receipt = store.state.receipts.find((r) => r.id === id);
            const correlated = receipt?.messageID ?? entry?.message.id;
            if (correlated && committedMessage(correlated)) {
              update(id, (receipt) => receipt.settled = true);
              finish(id, { kind: "committed", messageID: correlated });
              bind();
              return;
            }
            const failure = cause instanceof RequestFailure
              ? cause.failure
              : undefined;
            const certainty = failure?.facts?.outcome === "rejected"
              ? "definite"
              : "uncertain";
            const retry = () => {
              if (!entry || custody || certainty === "uncertain") {
                void owner.reload();
              } else entry.retry?.();
            };
            if (entry) {
              if (!dispatched) {
                // The draft and preparation owner's feedback remain authoritative.
                // No native Send exists to retain or retry in the transcript.
                transcript?.cancelSend?.(entry.message.id);
              } else {
                const classified = errorFeedback(failureValue(cause, {
                  actionLabel: "Sending prompt",
                  target: { ...input.target, label: input.title() },
                })) ?? presentFailure({
                  code: "send.released",
                  retry: "none",
                  diagnosticID: id,
                  facts: {
                    actionLabel: "Sending prompt",
                    target: { ...input.target, label: input.title() },
                    outcome: "unknown",
                    reason: "The send was released before completion.",
                  },
                });
                // This transcript entry is the failure surface, not a composer pointer.
                const feedback = classified.failure
                  ? presentFailure(classified.failure.value, {
                    surface: "record",
                    view: input.target,
                  })
                  : classified;
                // A definite rejection returns custody to the draft owner.
                // Keep the failed send visible, but there is no native send to
                // reconcile and only the recovered draft can submit again.
                const restored = !!custody && certainty === "definite";
                transcript?.send?.({
                  ...currentEntry(),
                  phase: "failed",
                  feedback: feedback &&
                    (restored ? { ...feedback, action: undefined } : {
                      ...feedback,
                      action: { label: "Retry", run: retry },
                    }),
                  retry: restored ? undefined : retry,
                });
              }
            }
            commit((s) => {
              s.receipts = s.receipts.filter((r) => r.id !== id);
            });
            finish(
              id,
              dispatched
                ? {
                  kind: "failed",
                  certainty,
                  reason: failure?.facts?.reason ??
                    "The message could not be sent.",
                  retry,
                  ...(failure ? { failure } : {}),
                }
                : refusedSend(cause),
            );
            return;
          }
          if (stopped) return;
          update(id, (receipt) => receipt.settled = true);
          // A pending entry carries OTK's supplied identity, so receipt-less
          // acceptance is observed by that ID within the entry's bounded
          // observation. Only sends without an entry lack any correlation.
          if (result?.state === "unconfirmed" || !result && !entry) {
            bind();
            const identity = entry?.message.id ?? messageID;
            if (identity && committedMessage(identity)) {
              return;
            }
            clear(id);
            const reason = result?.reason ??
              "The operation finished, but its message could not be confirmed.";
            const feedback = presentFailure({
              code: "send.unconfirmed",
              diagnosticID: id,
              retry: "none",
              facts: {
                actionLabel: "Sending message",
                reason,
                outcome: "unknown",
                origin: "composer",
                target: input.target,
                recovery:
                  "Check the session's latest messages before sending it again.",
              },
            }, { surface: "record", view: input.target });
            if (entry) {
              transcript?.send?.({
                ...currentEntry(),
                phase: "failed",
                feedback,
                retry: () => void owner.reload(),
              });
            }
            const unconfirmed: SendOutcome = {
              kind: "unconfirmed",
              reason,
              failure: feedback.failure?.value,
            };
            finish(id, unconfirmed);
            commit((s) => {
              s.last = s.receipts.find((r) => r.id === id);
              s.receipts = s.receipts.filter((r) => r.id !== id);
            });
            return;
          }
          if (!entry && !timers.has(id)) {
            timers.set(
              id,
              clock.set(() => unavailable(id), SEND_OBSERVATION_MS),
            );
          }
          update(id, (r) => {
            r.messageID = result?.messageID ?? entry?.message.id ?? messageID;
            if (r.phase !== "admitted" && r.phase !== "presented") {
              r.phase = result?.state === "queued" ? "queued" : "accepted";
            }
          });
          const watch = watches.get(id);
          if (watch && result?.messageID) watch.messageID = result.messageID;
          bind();
          if (entry) {
            // The pending transcript entry now owns this send (2.39): it
            // commits in place or fails visibly with Retry. A commitment that
            // bind() already observed has settled the outcome first.
            finish(id, {
              kind: "accepted",
              messageID: result?.messageID ?? entry.message.id,
            });
          }
          if (!store.state.receipts.some((r) => r.id === id)) return;
          if (!transcript) {
            unavailable(id);
            return;
          }
          if (result) {
            pins.set(id, transcript?.pin([result.messageID]) ?? (() => {}));
          }
          // Read-only recovery joins the existing authority. It never submits input.
          if (
            !result || !committedMessage(result.messageID)
          ) {
            void transcript?.reconcile(result ? [result.messageID] : []).then(
              inspect,
            ).catch((cause) => {
              console.error(
                "Send admission reconciliation diagnostic",
                input.target,
                cause,
              );
            });
          }
        })().catch((cause) => {
          if (stopped) return;
          clear(id);
          finish(
            id,
            watches.has(id)
              ? {
                kind: "failed",
                certainty: "uncertain",
                reason: "The message could not be confirmed.",
                retry: () => void owner.reload(),
              }
              : refusedSend(cause),
          );
        });
        return await outcome.promise;
      } catch (cause) {
        const outcome = refusedSend(cause);
        if (activated) {
          outcomes.get(activated)?.resolve(outcome);
          outcomes.delete(activated);
          clear(activated);
        }
        return outcome;
      }
    },
    presented(ids) {
      visible = new Set(ids);
      bind();
    },
    async reload() {
      if (stopped) return;
      commit((s) => {
        s.follow++;
      });
      bind();
      try {
        await transcript?.refetch();
      } catch (cause) {
        console.error(
          "Send admission reconciliation diagnostic",
          input.target,
          cause,
        );
      }
      if (!stopped) inspect();
    },
    stop() {
      stopped = true;
      release?.();
      release = undefined;
      visible.clear();
      applied.clear();
      for (const receipt of store.state.receipts) clear(receipt.id);
      for (const id of [...outcomes.keys()]) {
        const messageID = store.state.receipts.find((receipt) =>
          receipt.id === id
        )?.messageID;
        finish(
          id,
          messageID && committedMessage(messageID)
            ? { kind: "committed", messageID }
            : {
              kind: "unconfirmed",
              reason:
                "The submission owner stopped before native commitment could be confirmed.",
            },
        );
      }
      for (const id of watches.keys()) {
        observe(id, {
          kind: "unconfirmed",
          reason: "The submission owner stopped.",
        });
      }
      watches.clear();
    },
  };
  return owner;
}
