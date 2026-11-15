// SPDX-License-Identifier: LGPL-3.0-only
import { compareMessages, isRealPrompt } from "@otk/protocol";
import type {
  ContentSession,
  HistoryEntry,
  Message,
  MessagePage,
  NativeSource,
  NativeSourceView,
  PromptPart,
} from "@otk/protocol";
import type { Draft, Drafts } from "./drafts.ts";
import { sessionKey } from "./index.ts";
import { hasDraftContent } from "./draft-content.ts";
import { historyDraft } from "./prompt-history.ts";
import { RequestFailure } from "./failures.ts";
import { type FailureValue, failureValue } from "./failure-features.ts";
import type { Selection } from "./session.ts";
import { createState, type StateFactory } from "./state.ts";
import type { ServerResources } from "./server-resources.ts";
import type { TranscriptsOwner } from "./transcripts.ts";
import { branchDraftLabel, branchDraftLabels } from "./branch-draft-labels.ts";

export interface SavedBranch {
  id: string;
  boundary: string;
  created: number;
  session: ContentSession;
  messages: Message[];
  turns: MessagePage["turns"];
  prompts: { messageID: string; entry: HistoryEntry }[];
  drafts: { label: string; value: Draft }[];
  pending: boolean;
  replaced: boolean;
  /** Measured localStorage UTF-16 bytes, including its key. */
  bytes: number;
}
export interface BranchHistoryState {
  target?: Selection;
  branches: SavedBranch[];
  opened?: string;
  pending: boolean;
  error?: FailureValue;
  choice?: { branchID: string; label: string; draft: Draft };
}
export interface BranchHistory {
  readonly state: BranchHistoryState;
  /** A capability limitation, not a failed preservation attempt. */
  preservationWarning(): string | undefined;
  select(target: Selection | undefined): void;
  prepare(target: Selection, boundary: string): Promise<void>;
  beforeCommit(target: Selection, label?: string): Promise<void>;
  settled(target: Selection, restored?: boolean): Promise<void>;
  open(id?: string): void;
  reuse(branchID: string, draft: Draft, label: string): void;
  choose(saved: boolean): void;
  delete(id: string): void;
  fail(cause: unknown): void;
  subscribe(listener: () => void): () => void;
}
type StoredDraft = { label: string; value: Draft; defaultVariant: boolean };
type StoredBranch = Omit<SavedBranch, "drafts"> & {
  schema: 1;
  drafts: StoredDraft[];
};
const root = "otk.branch-history.v1/";
const same = (a: Selection | undefined, b: Selection) =>
  a?.sidecarId === b.sidecarId && a.sessionID === b.sessionID;
const draftKey = (t: Selection) => sessionKey(t.sidecarId, t.sessionID);
const occupied = (d: Draft) => hasDraftContent(d) || !!d.editor;
const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify(storedDraft("", a)) === JSON.stringify(storedDraft("", b));
function storedDraft(label: string, value: Draft): StoredDraft {
  return {
    label: branchDraftLabel(label),
    value,
    defaultVariant: Object.hasOwn(value, "variant") &&
      value.variant === undefined,
  };
}
/** Framework bindings may supply proxies; take a plain owned snapshot while
 * preserving the draft's explicit Default variant semantics. */
function cloneDraft(value: Draft): Draft {
  const stored = JSON.parse(
    JSON.stringify(storedDraft("", value)),
  ) as StoredDraft;
  return stored.defaultVariant
    ? { ...stored.value, variant: undefined }
    : stored.value;
}
function encode(branch: SavedBranch): string {
  return JSON.stringify({
    ...branch,
    schema: 1,
    drafts: branch.drafts.map((d) => storedDraft(d.label, d.value)),
  });
}
function decode(raw: string): SavedBranch {
  const value = JSON.parse(raw) as StoredBranch;
  if (
    value.schema !== 1 || typeof value.id !== "string" ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.prompts) || !Array.isArray(value.drafts) ||
    !value.session ||
    typeof value.boundary !== "string" || typeof value.created !== "number"
  ) {
    throw new Error("Invalid saved branch");
  }
  return {
    ...value,
    drafts: value.drafts.map((d) => ({
      label: branchDraftLabel(d.label),
      value: d.defaultVariant ? { ...d.value, variant: undefined } : d.value,
    })),
  };
}
/** One browser-owned archive boundary. Native history and files are never rewritten.
 * Capture before staging while ordinary pages still expose the full branch. This
 * precedes every native committing path, not just the Send button. */
export function createBranchHistory(options: {
  storage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem" | "key" | "length"
  >;
  server(target: Selection): string;
  supportsHistory?(target: Selection): boolean;
  title?(target: Selection): string | undefined;
  drafts: Drafts;
  page(target: Selection, before?: string): Promise<MessagePage>;
  prompt(target: Selection, messageID: string): Promise<HistoryEntry | null>;
  source(target: Selection, ref: string): Promise<NativeSourceView>;
  attachments(parts: PromptPart[], sidecarId: string): Promise<PromptPart[]>;
  session(target: Selection): Promise<ContentSession>;
  factory?: StateFactory;
}): BranchHistory {
  const store = (options.factory ?? createState)<BranchHistoryState>({
    branches: [],
    pending: false,
  });
  let selected: Selection | undefined;
  const supportsHistory = (t: Selection) =>
    options.supportsHistory?.(t) ?? true;
  const prefix = (t: Selection) =>
    root +
    encodeURIComponent(JSON.stringify([options.server(t), t.sessionID])) + "/";
  const fail = (
    t: Selection,
    reason: string,
    recovery: string,
    actionLabel = "Saving an earlier branch",
  ) => {
    const error = new RequestFailure({
      code: "branch-history.storage",
      retry: "new-intent",
      diagnosticID: crypto.randomUUID(),
      facts: {
        actionLabel,
        target: {
          sidecarId: t.sidecarId,
          sessionID: t.sessionID,
          label: options.title?.(t),
        },
        reason,
        recovery,
      },
    });
    if (same(selected, t)) {
      store.update((s) => {
        s.error = failureValue(error);
      });
    }
    return error;
  };
  const load = (t: Selection): SavedBranch[] => {
    try {
      const result: SavedBranch[] = [], start = prefix(t);
      for (let i = 0; i < options.storage.length; i++) {
        const key = options.storage.key(i);
        if (!key?.startsWith(start)) continue;
        const raw = options.storage.getItem(key);
        if (raw !== null) result.push(decode(raw));
      }
      return result.sort((a, b) =>
        b.created - a.created || b.id.localeCompare(a.id)
      );
    } catch {
      throw fail(
        t,
        "Saved branches could not be read from this browser. No stored data was changed.",
        "Restore access to browser localStorage, then reopen this session.",
        "Opening saved earlier branches",
      );
    }
  };
  const refresh = (t: Selection) => {
    if (!same(selected, t)) return;
    const branches = load(t);
    store.update((s) => {
      s.branches = branches;
      if (!branches.some((b) => b.id === s.opened)) s.opened = undefined;
      if (!branches.some((b) => b.id === s.choice?.branchID)) {
        s.choice = undefined;
      }
    });
  };
  const save = (
    t: Selection,
    input: SavedBranch,
    after = false,
    fresh = false,
  ) => {
    const key = prefix(t) + input.id, branch = structuredClone(input);
    // Include the serialized measurement field itself in the final exact count.
    let raw = encode(branch);
    do {
      branch.bytes = 2 * (key.length + raw.length);
      raw = encode(branch);
    } while (branch.bytes !== 2 * (key.length + raw.length));
    try {
      // Explicit deletion retires the archive lifetime. A late attachment read
      // or native settlement may not recreate that deleted copy.
      if (!fresh && options.storage.getItem(key) === null) {
        refresh(t);
        return false;
      }
      options.storage.setItem(key, raw);
    } catch (cause) {
      if (after) {
        throw fail(
          t,
          "The branch copy remains saved, but its latest status was not saved. The native action already ran.",
          "Free browser storage or restore storage access, then reopen this session.",
          "Updating saved branch status",
        );
      }
      const quota = !!cause && typeof cause === "object" && "name" in cause &&
        cause.name === "QuotaExceededError";
      throw fail(
        t,
        quota
          ? `The earlier branch and draft (${branch.bytes.toLocaleString()} bytes) were not saved: this browser's localStorage is full (about 5 MB per origin). The native action was not sent.`
          : `The earlier branch and draft (${branch.bytes.toLocaleString()} bytes) were not saved: browser localStorage is unavailable. The native action was not sent.`,
        "Delete a saved branch you no longer need, or free browser storage, then retry. If this branch alone is too large, keep the live conversation; it cannot fit here. Older branches were not removed.",
      );
    }
    if (same(selected, t)) {
      store.update((s) => {
        s.error = undefined;
      });
    }
    refresh(t);
    return true;
  };
  const retain = (branch: SavedBranch, label: string, value: Draft) => {
    if (!branch.drafts.some((d) => sameDraft(d.value, value))) {
      branch.drafts.push({ label, value: cloneDraft(value) });
    }
  };
  const prepare = async (t: Selection, boundary: string) => {
    if (!supportsHistory(t)) return;
    const before = structuredClone(options.drafts.current(draftKey(t)));
    if (same(selected, t)) {
      store.update((s) => {
        s.pending = true;
        s.error = undefined;
      });
    }
    try {
      const existing = load(t);
      const pending = existing.find((b) => b.pending);
      if (pending && (await options.session(t)).revert) return;
      for (const previous of existing.filter((b) => b.pending)) {
        previous.pending = false;
        save(t, previous);
      }
      let cursor: string | undefined, initial: MessagePage | undefined;
      const messages: Message[] = [],
        prompts: SavedBranch["prompts"] = [],
        turns: MessagePage["turns"] = {};
      const seen = new Set<string>();
      const sourceViews = new Map<string, NativeSourceView>();
      do {
        const page = await options.page(t, cursor);
        initial ??= page;
        if (
          page.session.revert || page.clock.epoch !== initial.clock.epoch ||
          page.clock.seq !== initial.clock.seq
        ) {
          throw fail(
            t,
            "The conversation changed before its earlier branch could be saved. Revert was not sent.",
            "Restore the pending conversation if needed, then retry Revert when it is settled.",
          );
        }
        for (const message of page.items) {
          const holders: { source?: NativeSource }[] = [message];
          for (const part of message.parts) {
            if ("source" in part) holders.push(part);
            if (part.kind !== "tool") continue;
            const calls = [part.call];
            while (calls.length) {
              const call = calls.pop()!;
              holders.push(call);
              calls.push(...call.children ?? []);
            }
          }
          for (const holder of holders) {
            const source = holder.source;
            if (!source?.ref) continue;
            const view = sourceViews.get(source.ref) ??
              await options.source(t, source.ref);
            sourceViews.set(source.ref, view);
            const { ref: _ref, ...saved } = source;
            holder.source = { ...saved, ...view };
          }
        }
        messages.push(...page.items);
        Object.assign(turns, page.turns);
        for (const message of page.items) {
          if (!isRealPrompt(message)) continue;
          const entry = await options.prompt(t, message.id);
          if (!entry) {
            throw fail(
              t,
              "An earlier prompt could not be saved exactly. Revert was not sent.",
              "Restore access to the original prompt and its attachments, then retry.",
            );
          }
          entry.parts = await options.attachments(entry.parts, t.sidecarId);
          prompts.push({ messageID: message.id, entry });
        }
        cursor = page.older ?? undefined;
        if (cursor && seen.has(cursor)) {
          throw fail(
            t,
            "The earlier branch could not be read completely. Revert was not sent.",
            "Reload this session, then retry Revert.",
          );
        }
        if (cursor) seen.add(cursor);
      } while (cursor);
      const final = await options.page(t);
      if (
        final.clock.epoch !== initial!.clock.epoch ||
        final.clock.seq !== initial!.clock.seq || final.session.revert
      ) {
        throw fail(
          t,
          "The conversation changed while saving its earlier branch. Revert was not sent.",
          "Retry Revert when the conversation is settled.",
        );
      }
      // Resolve history-backed draft chips too; no source-only attachment survives deletion.
      const materialize = async (draft: Draft) => {
        const parts = await options.attachments(
          draft.chips.map((c) => c.part),
          t.sidecarId,
        );
        return {
          ...draft,
          chips: draft.chips.map((c, i) => ({ ...c, part: parts[i] })),
        };
      };
      const original = options.drafts.reverts.get(draftKey(t))?.before ??
        before;
      const branch: SavedBranch = {
        id: crypto.randomUUID(),
        boundary,
        created: Date.now(),
        session: initial!.session,
        messages: messages.sort(compareMessages),
        turns,
        prompts,
        drafts: [],
        pending: true,
        replaced: false,
        bytes: 0,
      };
      retain(
        branch,
        branchDraftLabels.beforeRevert,
        await materialize(original),
      );
      retain(branch, branchDraftLabels.atRevert, await materialize(before));
      save(t, branch, false, true);
    } finally {
      if (same(selected, t)) {
        store.update((s) => {
          s.pending = false;
        });
      }
    }
  };
  const reuse = (id: string, value: Draft, label: string) => {
    label = branchDraftLabel(label);
    const t = selected;
    if (!t) return;
    const branch = load(t).find((b) => b.id === id);
    if (!branch) return;
    const current = options.drafts.current(draftKey(t));
    retain(branch, branchDraftLabels.keptComposer, current);
    retain(branch, label, value);
    if (!save(t, branch)) return; // Neither quota nor deletion can displace a draft.
    if (occupied(current) && !sameDraft(current, value)) {
      store.update((s) => {
        s.choice = { branchID: id, label, draft: cloneDraft(value) };
      });
      return;
    }
    options.drafts.writer(draftKey(t))(cloneDraft(value));
  };
  return {
    state: store.state,
    preservationWarning: () => {
      const target = store.state.target;
      return target && !supportsHistory(target)
        ? "This branch can't be kept after you send (this server doesn't provide prompt history)."
        : undefined;
    },
    subscribe: (listener) => store.subscribe(listener),
    select(target) {
      if (target && same(selected, target)) return;
      selected = target && { ...target };
      store.update((s) => {
        s.target = selected;
        s.opened = undefined;
        s.choice = undefined;
        s.error = undefined;
        s.branches = [];
      });
      if (target) {
        try {
          refresh(target);
        } catch { /* Already presented by fail. */ }
      }
    },
    prepare,
    async beforeCommit(t, label: string = branchDraftLabels.beforeSending) {
      if (!supportsHistory(t)) return;
      if (!load(t).some((b) => b.pending)) return;
      const session = await options.session(t);
      if (!session.revert) return;
      const branch = load(t).find((b) => b.pending);
      if (!branch) {
        throw fail(
          t,
          "This reverted branch was not saved in this browser. The native action was not sent.",
          "Use Restore conversation first, then revert again in this browser to save it.",
        );
      }
      const value = structuredClone(options.drafts.current(draftKey(t)));
      const parts = await options.attachments(
        value.chips.map((c) => c.part),
        t.sidecarId,
      );
      value.chips = value.chips.map((c, i) => ({ ...c, part: parts[i] }));
      retain(branch, label, value);
      save(t, branch);
    },
    async settled(t, restored = false) {
      if (!supportsHistory(t)) return;
      // Bookkeeping after native dispatch must never make an admitted send look
      // unsent. The complete pre-action archive already remains durable.
      try {
        const branch = load(t).find((b) => b.pending);
        if (!branch || (!restored && (await options.session(t)).revert)) return;
        branch.pending = false;
        branch.replaced = !restored;
        if (!save(t, branch, true)) return;
        const transaction = options.drafts.reverts.get(draftKey(t));
        const original = branch.drafts[0]?.value;
        if (
          restored && transaction?.edited && original && same(selected, t) &&
          !sameDraft(options.drafts.current(draftKey(t)), original)
        ) {
          store.update((s) => {
            s.choice = {
              branchID: branch.id,
              label: branchDraftLabels.savedDraft,
              draft: cloneDraft(original),
            };
          });
        }
      } catch {
        fail(
          t,
          "The branch copy remains saved, but its latest status could not be confirmed. The native action already ran.",
          "Reopen this session after restoring the connection and browser storage access.",
          "Updating saved branch status",
        );
      }
    },
    open(id) {
      store.update((s) => {
        s.opened = id;
        s.choice = undefined;
        s.error = undefined;
      });
    },
    reuse,
    fail(cause) {
      store.update((s) => {
        s.error = failureValue(cause, {
          actionLabel: "Using a saved earlier branch",
          target: selected &&
            { sidecarId: selected.sidecarId, sessionID: selected.sessionID },
        });
      });
    },
    choose(saved) {
      const t = selected, choice = store.state.choice;
      if (!t || !choice) return;
      if (saved) {
        const branch = load(t).find((b) => b.id === choice.branchID);
        if (!branch) return;
        retain(
          branch,
          branchDraftLabels.keptComposer,
          options.drafts.current(draftKey(t)),
        );
        if (!save(t, branch)) return;
        options.drafts.writer(draftKey(t))(cloneDraft(choice.draft));
      }
      store.update((s) => {
        s.choice = undefined;
      });
    },
    delete(id) {
      if (!selected) return;
      try {
        options.storage.removeItem(prefix(selected) + id);
      } catch {
        throw fail(
          selected,
          "The saved branch was not deleted: browser localStorage is unavailable.",
          "Restore browser storage access, then retry Delete.",
          "Deleting a saved branch",
        );
      }
      store.update((s) => {
        if (s.choice?.branchID === id) s.choice = undefined;
      });
      refresh(selected);
    },
  };
}

/** Keeps the exact captured text, rather than manufacturing attachment tokens. */
export function savedPromptDraft(entry: HistoryEntry): Draft {
  const value = historyDraft(entry);
  value.input = entry.input;
  value.chips = value.chips.map((chip) => {
    if (chip.start === undefined || chip.end! <= entry.input.length) {
      return chip;
    }
    const { start: _start, end: _end, ...independent } = chip;
    return independent;
  });
  return value;
}

/** Production composition stays in the client; shell bindings inject owners,
 * never acquire transcript bodies or select RPC operations themselves. */
export function connectBranchHistory(options: {
  storage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem" | "key" | "length"
  >;
  api: URL;
  resources: ServerResources;
  transcripts: TranscriptsOwner;
  drafts: Drafts;
  attachments(parts: PromptPart[], sidecarId: string): Promise<PromptPart[]>;
  factory?: StateFactory;
}): BranchHistory {
  const { resources, transcripts } = options;
  const rpc = (target: Selection) =>
    resources.sidecars.connection(target.sidecarId).rpc;
  return createBranchHistory({
    storage: options.storage,
    drafts: options.drafts,
    attachments: options.attachments,
    factory: options.factory,
    supportsHistory: (target) =>
      resources.declares(target.sidecarId, "history"),
    server: (target) =>
      new URL(
        resources.server(target.sidecarId)?.baseUrl || options.api.href,
        options.api,
      ).href,
    title: (target) =>
      resources.entry(target.sidecarId, target.sessionID)?.title,
    page: (target, before) => transcripts.snapshotPage(target, before),
    prompt: (target, messageID) =>
      rpc(target).call("history.prompt", {
        sessionID: target.sessionID,
        messageID,
      }),
    source: (target, ref) =>
      rpc(target).call("source.get", { sessionID: target.sessionID, ref }),
    session: (target) =>
      rpc(target).call("session.get", { sessionID: target.sessionID }),
  });
}
