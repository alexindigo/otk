// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef, PromptPart } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { createDraftReverts, type DraftReverts } from "./draft-revert.ts";
import type { SendOutcome } from "./send-outcome.ts";
import type { ClientIntent } from "./requests.ts";

export interface DraftSendCapture {
  readonly draft: Draft;
  readonly activation?: string;
  take(
    messageID: string,
    check: () => void,
    intent?: ClientIntent,
  ): ((outcome: SendOutcome) => boolean | void) | undefined;
}

export interface DraftRecovery {
  readonly id: string;
  readonly kind: "uncertain" | "recoverable";
  readonly cause?: "withdrawn" | "stop-unconfirmed";
  readonly draft: Draft;
  run(): void;
  discard(): void;
}

type RecoveryOffer = Pick<DraftRecovery, "kind" | "cause">;
type SavedSend = {
  /** Discard can release custody while native observation is still pending. */
  draft?: Draft;
  intent?: ClientIntent;
  vacancy?: number;
  waiting: boolean;
  offer?: RecoveryOffer;
};
type Capture = {
  saved: SavedSend;
  recovery?: DraftRecovery;
  check?: () => void;
};
type DraftOwner = {
  draft: Draft;
  revision: number;
  sends: Map<string, Capture>;
};

export interface Chip {
  id: string;
  label: string;
  /** Paired coordinates for an inline token; absent for independent attachments. */
  start?: number;
  end?: number;
  part: PromptPart;
  pending?: boolean;
  error?: import("./failure-features.ts").FailureValue;
}
export interface Draft {
  input: string;
  chips: Chip[];
  mode: "normal" | "shell";
  agent?: string;
  model?: ModelRef;
  /** Missing means inherit; an own undefined value means explicitly Default. */
  variant?: string;
  editor?: { text: string; chipID?: string };
}
export type DraftChange = Draft | ((current: Draft) => Draft);
export const emptyDraft = (): Draft => ({
  input: "",
  chips: [],
  mode: "normal",
});

/** Replace content without taking ownership of this draft's prompt choices. */
export function replaceDraftContent(
  draft: Draft,
  content: Pick<Draft, "input" | "chips" | "mode">,
): Draft {
  const next = {
    ...draft,
    input: content.input,
    chips: content.chips,
    mode: content.mode,
  };
  delete next.editor;
  return next;
}

/** Clear submitted content while retaining explicit next-prompt choices. */
export function clearDraft(draft: Draft): Draft {
  return replaceDraftContent(draft, emptyDraft());
}

/** Browser-lifetime drafts, keyed by server and session, never session content. */
export interface Drafts {
  snapshot(): unknown;
  restore(value: unknown): void;
  readonly reverts: DraftReverts;
  get(key: string): Draft;
  /** Invocation-current, non-creating read without framework publication tracking. */
  current(key: string): Draft;
  writer(key: string): (change: DraftChange) => Draft;
  captureSend(key: string, draft: Draft): DraftSendCapture;
  pendingSends(): { key: string; messageID: string; intent?: ClientIntent }[];
  resumeSend(key: string, messageID: string, check: () => void):
    | ((outcome: SendOutcome) => boolean | void)
    | undefined;
  recoveries(key: string): readonly DraftRecovery[];
  drop(key: string): void;
  subscribe(listener: () => void): () => void;
}
export function createDrafts(factory: StateFactory = createState): Drafts {
  const values = new Map<string, DraftOwner>();
  const newOwner = (draft: Draft): DraftOwner => ({
    draft,
    revision: 0,
    sends: new Map(),
  });
  const store = factory({ revision: 0 });
  const current = (key: string) => values.get(key)?.draft ?? emptyDraft();
  const get = (key: string): Draft => {
    void store.state.revision;
    return current(key);
  };
  const changed = () =>
    store.update((state) => {
      state.revision++;
    });
  const writer = (key: string, transaction = false) => {
    let owner = values.get(key);
    if (!owner) {
      owner = newOwner(emptyDraft());
      values.set(key, owner);
    }
    const captured = owner;
    return (change: DraftChange): Draft => {
      if (values.get(key) !== captured) return current(key);
      const previous = captured.draft;
      const next = typeof change === "function" ? change(previous) : change;
      captured.draft = next;
      if (next !== previous) {
        captured.revision++;
        if (!transaction) reverts.changed(key);
        changed();
      }
      return next;
    };
  };
  const reverts = createDraftReverts({
    current,
    writer: (key) => writer(key, true),
  });
  const active = (key: string, owner: DraftOwner, id: string, value: Capture) =>
    values.get(key) === owner && owner.sends.get(id) === value;
  const offer = (
    key: string,
    owner: DraftOwner,
    id: string,
    value: Capture,
    kind: DraftRecovery["kind"],
    cause?: DraftRecovery["cause"],
  ) => {
    if (!value.saved.draft) return;
    if (value.recovery?.kind === kind && value.recovery.cause === cause) return;
    const offered = () =>
      active(key, owner, id, value) && value.recovery === recovery;
    const recovery: DraftRecovery = {
      id,
      kind,
      cause,
      get draft() {
        void store.state.revision;
        return value.saved.draft ?? emptyDraft();
      },
      run() {
        const recovered = value.saved.draft;
        if (!offered() || !recovered) return;
        if (kind === "uncertain") return value.check?.();
        // Exchange at the sole draft owner. Late native evidence cannot retire
        // the newer draft parked by this exchange.
        value.saved.draft = owner.draft;
        value.saved.waiting = false;
        if (cause === "stop-unconfirmed") {
          if (
            value.saved.draft.input.trim() || value.saved.draft.chips.length ||
            value.saved.draft.editor
          ) {
            offer(key, owner, id, value, "recoverable");
          } else owner.sends.delete(id);
        }
        writer(key)(recovered);
      },
      discard() {
        if (!offered()) return;
        if (value.saved.waiting) {
          // Keep the correlation for reload/late native evidence, not the copy.
          delete value.saved.draft;
          delete value.saved.offer;
          delete value.saved.vacancy;
          delete value.recovery;
        } else owner.sends.delete(id);
        changed();
      },
    };
    value.saved.offer = { kind, cause };
    value.recovery = recovery;
    changed();
  };
  const resumeSend: Drafts["resumeSend"] = (key, id, check) => {
    const owner = values.get(key);
    const value = owner?.sends.get(id);
    if (!owner || !value?.saved.waiting || value.check) return;
    value.check = check;
    return (outcome) => {
      if (!active(key, owner, id, value) || !value.saved.waiting) return;
      if (outcome.kind === "accepted" || outcome.kind === "committed") return;
      if (outcome.kind === "started") {
        owner.sends.delete(id);
        changed();
      } else if (outcome.kind === "unconfirmed" && outcome.stop) {
        offer(key, owner, id, value, "recoverable", "stop-unconfirmed");
      } else if (
        outcome.kind === "unconfirmed" ||
        outcome.kind === "failed" && outcome.certainty === "uncertain"
      ) {
        if (!value.saved.offer?.cause) {
          offer(key, owner, id, value, "uncertain");
        }
      } else {
        value.saved.waiting = false;
        const draft = value.saved.draft;
        if (!draft) {
          owner.sends.delete(id);
          changed();
          return;
        }
        if (owner.revision === value.saved.vacancy) {
          owner.sends.delete(id);
          writer(key)(draft);
          return true;
        }
        offer(
          key,
          owner,
          id,
          value,
          "recoverable",
          outcome.kind === "withdrawn" ? "withdrawn" : undefined,
        );
      }
    };
  };
  return {
    snapshot: () => {
      if (
        [...values.values()].some(({ draft, sends }) =>
          [draft, ...[...sends.values()].map((value) => value.saved.draft)]
            .some((value) => value?.chips.some((chip) => chip.pending))
        )
      ) {
        throw new Error(
          "Wait for attachments to finish reading before reloading",
        );
      }
      return {
        drafts: [...values].map(([key, value]) => [key, value.draft]),
        sends: [...values].flatMap(([key, owner]) =>
          owner.sends.size
            ? [{
              key,
              revision: owner.revision,
              items: [...owner.sends].map(([id, value]) => [id, value.saved]),
            }]
            : []
        ),
        reverts: reverts.snapshot(),
      };
    },
    restore(value) {
      const snapshot = value as {
        drafts: [string, Draft][];
        sends?: {
          key: string;
          revision: number;
          items: [string, SavedSend][];
        }[];
        reverts: unknown;
      };
      for (const [key, draft] of snapshot.drafts) {
        values.set(key, newOwner(draft));
      }
      for (const { key, revision, items } of snapshot.sends ?? []) {
        const owner = values.get(key);
        if (!owner) throw new Error("Captured send has no draft owner");
        owner.revision = revision;
        for (const [id, saved] of items) {
          const value = { saved: { ...saved } };
          owner.sends.set(id, value);
          if (saved.offer) {
            offer(key, owner, id, value, saved.offer.kind, saved.offer.cause);
          }
        }
      }
      reverts.restore(snapshot.reverts);
      changed();
    },
    reverts,
    get,
    current,
    writer: (key) => writer(key),
    captureSend(key, draft) {
      const owner = values.get(key);
      const revision = owner?.draft === draft ? owner.revision : undefined;
      const captured = structuredClone(draft);
      let taken = false;
      return {
        draft: captured,
        take(id, check, intent) {
          if (
            taken || !owner || values.get(key) !== owner || owner.sends.has(id)
          ) return;
          taken = true;
          const vacancy = revision === owner.revision
            ? revision + 1
            : undefined;
          owner.sends.set(id, {
            saved: { draft: captured, vacancy, intent, waiting: true },
          });
          if (vacancy !== undefined) writer(key)(clearDraft(owner.draft));
          return resumeSend(key, id, check);
        },
      };
    },
    pendingSends: () =>
      [...values].flatMap(([key, owner]) =>
        [...owner.sends].flatMap(([messageID, { saved, check }]) =>
          saved.waiting && !check
            ? [{ key, messageID, intent: saved.intent }]
            : []
        )
      ),
    resumeSend,
    recoveries(key) {
      void store.state.revision;
      const owner = values.get(key);
      return owner
        ? [...owner.sends.values()].flatMap(({ recovery }) =>
          recovery ? [recovery] : []
        )
        : [];
    },
    drop(key) {
      reverts.drop(key);
      if (values.delete(key)) changed();
    },
    subscribe: store.subscribe,
  };
}
