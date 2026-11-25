// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef, PromptPart } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { createDraftReverts, type DraftReverts } from "./draft-revert.ts";
import type { SendOutcome } from "./send-outcome.ts";

export interface DraftSendCapture {
  readonly draft: Draft;
  readonly activation?: string;
  take(
    messageID: string,
    check: () => void,
  ): ((outcome: SendOutcome) => boolean | void) | undefined;
}

export interface DraftRecovery {
  readonly id: string;
  readonly kind: "uncertain" | "recoverable";
  readonly cause?: "withdrawn" | "stop-unconfirmed";
  readonly draft: Draft;
  run(): void;
}

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
  recoveries(key: string): readonly DraftRecovery[];
  drop(key: string): void;
  subscribe(listener: () => void): () => void;
}
export function createDrafts(factory: StateFactory = createState): Drafts {
  const values = new Map<string, {
    draft: Draft;
    revision: number;
    sends: Map<string, { draft: Draft; recovery?: DraftRecovery }>;
  }>();
  const newOwner = (draft: Draft) => ({
    draft,
    revision: 0,
    sends: new Map<string, { draft: Draft; recovery?: DraftRecovery }>(),
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
  return {
    snapshot: () => {
      if (
        [...values.values()].some(({ draft }) =>
          draft.chips.some((chip) => chip.pending)
        )
      ) {
        throw new Error(
          "Wait for attachments to finish reading before reloading",
        );
      }
      return {
        drafts: [...values].map(([key, value]) => [key, value.draft]),
        reverts: reverts.snapshot(),
      };
    },
    restore(value) {
      const snapshot = value as { drafts: [string, Draft][]; reverts: unknown };
      for (const [key, draft] of snapshot.drafts) {
        values.set(key, newOwner(draft));
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
        take(id, check) {
          if (
            taken || !owner || values.get(key) !== owner || owner.sends.has(id)
          ) return;
          taken = true;
          const value: { draft: Draft; recovery?: DraftRecovery } = {
            draft: captured,
          };
          owner.sends.set(id, value);
          const write = writer(key);
          const vacancy = revision === owner.revision
            ? revision + 1
            : undefined;
          if (vacancy !== undefined) write(clearDraft(owner.draft));
          const active = () =>
            values.get(key) === owner && owner.sends.get(id) === value;
          let exchanged = false;
          const offer = (
            kind: DraftRecovery["kind"],
            cause?: DraftRecovery["cause"],
          ) => {
            if (
              value.recovery?.kind === kind && value.recovery.cause === cause
            ) return;
            const recovery: DraftRecovery = {
              id,
              kind,
              cause,
              get draft() {
                void store.state.revision;
                return value.draft;
              },
              run() {
                if (!active() || value.recovery !== recovery) return;
                if (kind === "uncertain") return check();
                // An explicit exchange keeps the displaced full draft too;
                // that parked draft has no outstanding native send.
                const recovered = value.draft;
                value.draft = owner.draft;
                if (cause === "stop-unconfirmed") {
                  // Late evidence concerns the submitted draft, not the newer
                  // draft parked by this exchange.
                  exchanged = true;
                  value.recovery = undefined;
                  if (value.draft.input.trim() || value.draft.chips.length) {
                    offer("recoverable");
                  } else owner.sends.delete(id);
                }
                write(recovered);
              },
            };
            value.recovery = recovery;
            changed();
          };
          return (outcome) => {
            if (!active() || exchanged) return;
            if (outcome.kind === "accepted" || outcome.kind === "committed") {
              return;
            }
            if (outcome.kind === "started") {
              owner.sends.delete(id);
              changed();
            } else if (outcome.kind === "unconfirmed" && outcome.stop) {
              offer("recoverable", "stop-unconfirmed");
            } else if (
              outcome.kind === "unconfirmed" ||
              outcome.kind === "failed" && outcome.certainty === "uncertain"
            ) {
              if (!value.recovery?.cause) offer("uncertain");
            } else if (owner.revision === vacancy) {
              owner.sends.delete(id);
              write(value.draft);
              return true;
            } else {
              offer(
                "recoverable",
                outcome.kind === "withdrawn" ? "withdrawn" : undefined,
              );
            }
          };
        },
      };
    },
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
