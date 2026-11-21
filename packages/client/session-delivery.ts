// SPDX-License-Identifier: LGPL-3.0-only
import { type ContentClock, type PromptReceipt, randomID } from "@otk/protocol";
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

/** This is an observation deadline, never a mutation timeout or permission to resend. */
export const SEND_OBSERVATION_MS = 10_000;
export interface DeliveryReceipt {
  id: string;
  messageID?: string;
  phase: "submitted" | "accepted" | "queued" | "admitted" | "presented";
  clock?: ContentClock;
  feedback?: Feedback;
  entry?: boolean;
}
export interface SessionDelivery {
  readonly state: {
    receipts: readonly DeliveryReceipt[];
    follow: number;
    last?: DeliveryReceipt;
  };
  subscribe(listener: () => void): () => void;
  send(
    action: (dispatch: () => void) => Promise<PromptReceipt | null>,
    entry?: PendingSend,
  ): Promise<void>;
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
  const inspect = () => {
    if (stopped) return;
    for (const receipt of [...store.state.receipts]) {
      if (!receipt.messageID || receipt.phase === "presented") continue;
      const message = transcript?.projection.state
        .messagesByID[receipt.messageID];
      if (
        message?.sessionID !== input.target.sessionID || message.role !== "user"
      ) continue;
      if (!transcript?.projection.committed(receipt.messageID)) continue;
      if (receipt.phase !== "admitted") {
        update(receipt.id, (r) => {
          r.phase = "admitted";
          r.clock = transcript?.state.clock;
          r.feedback = undefined;
        });
      }
      if (visible.has(receipt.messageID)) {
        clear(receipt.id);
        commit((s) => {
          s.last = { ...receipt, phase: "presented", feedback: undefined };
          s.receipts = s.receipts.filter((r) => r.id !== receipt.id);
        });
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
  const unavailable = (id: string) =>
    update(id, (receipt) => {
      if (receipt.phase === "presented") return;
      receipt.feedback = presentFailure({
        code: "send.observation",
        retry: "none",
        diagnosticID: receipt.id,
        facts: {
          actionLabel: "Sending prompt",
          target: { ...input.target, label: input.title() },
          reason: receipt.phase === "admitted"
            ? "The sent message was admitted, but its presentation has not been observed."
            : "opencode accepted this message, but its transcript admission has not been observed.",
          recovery:
            "Reload this session's latest messages. Do not send it again.",
        },
      }, { surface: "record", view: input.target });
    });
  const owner: SessionDelivery = {
    get state() {
      void binding.state.revision;
      return store.state;
    },
    subscribe: (listener) => store.subscribe(listener),
    async send(action, entry) {
      if (stopped) {
        throw new DOMException("Submission owner stopped", "AbortError");
      }
      bind();
      const id = entry?.intent.key ?? randomID();
      if (entry) {
        if (transcript?.projection.committed(entry.message.id)) return;
        if (store.state.receipts.some((receipt) => receipt.id === id)) return;
      }
      commit((s) => {
        s.receipts.push({
          id,
          phase: "submitted",
          messageID: entry?.message.id,
          entry: !!entry,
        });
        s.follow++;
      });
      if (entry) {
        const publish = (value: PendingSend) => transcript?.send?.(value);
        const observeAgain = () => {
          publish({ ...entry, phase: "pending" });
          timers.set(
            id,
            clock.set(() => failObservation(), SEND_OBSERVATION_MS),
          );
          void owner.reload();
        };
        const failObservation = () => {
          const receipt = store.state.receipts.find((r) => r.id === id);
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
            ...entry,
            phase: "failed",
            feedback: feedback &&
              { ...feedback, action: { label: "Retry", run: observeAgain } },
            retry: observeAgain,
          });
        };
        publish(entry);
        timers.set(id, clock.set(failObservation, SEND_OBSERVATION_MS));
      }
      let result: PromptReceipt | null;
      let dispatched = false;
      try {
        result = await action(() => dispatched = true);
      } catch (cause) {
        clear(id);
        if (entry) {
          const receipt = store.state.receipts.find((r) => r.id === id);
          if (
            transcript?.projection.committed(entry.message.id) ||
            receipt?.phase === "admitted" || store.state.last?.id === id
          ) return;
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
              retry: "new-intent",
              diagnosticID: id,
              facts: {
                actionLabel: "Sending prompt",
                target: { ...input.target, label: input.title() },
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
            const retry = () => {
              if (
                cause instanceof RequestFailure &&
                (cause.failure.facts?.outcome === "unknown" ||
                  cause.failure.facts?.outcome === "unavailable")
              ) {
                void owner.reload();
              } else entry.retry?.();
            };
            transcript?.send?.({
              ...entry,
              phase: "failed",
              feedback: feedback &&
                { ...feedback, action: { label: "Retry", run: retry } },
              retry,
            });
          }
        }
        commit((s) => {
          s.receipts = s.receipts.filter((r) => r.id !== id);
        });
        throw cause;
      }
      if (stopped) return;
      update(id, (r) => {
        r.messageID = result?.messageID ?? entry?.message.id;
        if (r.phase !== "admitted" && r.phase !== "presented") {
          r.phase = result?.state ?? "accepted";
        }
      });
      bind();
      if (!store.state.receipts.some((r) => r.id === id)) return;
      if (!transcript) {
        unavailable(id);
        return;
      }
      if (result) {
        pins.set(id, transcript?.pin([result.messageID]) ?? (() => {}));
      }
      if (!entry) {
        timers.set(
          id,
          clock.set(() => {
            timers.delete(id);
            unavailable(id);
          }, SEND_OBSERVATION_MS),
        );
      }
      // Read-only recovery joins the existing authority. It never submits input.
      if (
        !result || !transcript?.projection.committed(result.messageID)
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
    },
    presented(ids) {
      visible = new Set(ids);
      bind();
    },
    async reload() {
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
      for (const receipt of store.state.receipts) clear(receipt.id);
    },
  };
  return owner;
}
