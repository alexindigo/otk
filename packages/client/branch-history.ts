// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
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
import type { FeedbackOwner } from "./failures.ts";
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
interface CaptureDrafts {
  original: Draft;
  atRevert: Draft;
  restored?: { current: Draft; edited: boolean };
}
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
/** Staging is reversible; one background capture gates every committing path.
 * Archive pages include native retained history hidden from the live view. */
export function createBranchHistory(options: {
  storage:
    | Pick<
      Storage,
      "getItem" | "setItem" | "removeItem" | "key" | "length"
    >
    | null;
  server(target: Selection): string;
  supportsHistory?(target: Selection): boolean;
  title?(target: Selection): string | undefined;
  feedback?(target: Selection): FeedbackOwner;
  drafts: Drafts;
  page(
    target: Selection,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MessagePage>;
  prompt(
    target: Selection,
    messageID: string,
    signal?: AbortSignal,
  ): Promise<HistoryEntry | null>;
  source(
    target: Selection,
    ref: string,
    signal?: AbortSignal,
  ): Promise<NativeSourceView>;
  concurrency?(target: Selection): number;
  attachments(parts: PromptPart[], sidecarId: string): Promise<PromptPart[]>;
  session(target: Selection): Promise<ContentSession>;
  factory?: StateFactory;
}): BranchHistory {
  const store = (options.factory ?? createState)<BranchHistoryState>({
    branches: [],
    pending: false,
  });
  let selected: Selection | undefined;
  const captures = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
      boundary: string;
      drafts: CaptureDrafts;
    }
  >();
  const failures = new Map<string, RequestFailure>();
  const clearFailure = (t: Selection) => {
    const failure = failures.get(draftKey(t)), feedback = options.feedback?.(t);
    if (
      failure &&
      feedback?.current()?.diagnosticID === failure.failure.diagnosticID
    ) feedback.clear();
    failures.delete(draftKey(t));
  };
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
      diagnosticID: randomID(),
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
    failures.set(draftKey(t), error);
    options.feedback?.(t).fail(error);
    if (same(selected, t)) {
      store.update((s) => {
        s.error = failureValue(error);
      });
    }
    return error;
  };
  const load = (t: Selection): SavedBranch[] => {
    if (!options.storage) return [];
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
      if (!options.storage) {
        throw new Error("Browser persistence is unavailable");
      }
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
          ? `The earlier branch and draft (${branch.bytes.toLocaleString()} bytes) were not saved: this browser's localStorage is full (about 5 MB per origin). The replacement was not sent.`
          : `The earlier branch and draft (${branch.bytes.toLocaleString()} bytes) were not saved: browser localStorage is unavailable. The replacement was not sent.`,
        "Delete a saved branch you no longer need, or free browser storage, then retry. If this branch alone is too large, keep the live conversation; it cannot fit here. Older branches were not removed.",
      );
    }
    clearFailure(t);
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
  const capture = async (
    t: Selection,
    boundary: string,
    signal: AbortSignal,
    drafts: CaptureDrafts,
  ) => {
    signal.throwIfAborted();
    if (!supportsHistory(t)) return;
    const before = drafts.atRevert;
    if (same(selected, t)) {
      store.update((s) => {
        s.pending = true;
        s.error = undefined;
      });
    }
    try {
      if (!options.storage) {
        throw fail(
          t,
          "The earlier branch and draft were not saved: browser localStorage is unavailable. The replacement was not sent.",
          "Restore browser storage access, then retry Send or restore the conversation.",
        );
      }
      // Session acquisition can yield to reuse or native settlement. Never use
      // a pre-await archive snapshot to decide or overwrite pending ownership.
      const session = load(t).some((b) => b.pending)
        ? await options.session(t)
        : undefined;
      signal.throwIfAborted();
      const existing = load(t);
      const pending = existing.find((b) => b.pending);
      if (pending && session?.revert) return;
      for (const previous of existing.filter((b) => b.pending)) {
        previous.pending = false;
        save(t, previous);
      }
      let cursor: string | undefined, initial: MessagePage | undefined;
      const messages: Message[] = [],
        prompts: SavedBranch["prompts"] = [],
        turns: MessagePage["turns"] = {};
      const seen = new Set<string>();
      const parallel = async <T>(
        values: T[],
        run: (value: T) => Promise<void>,
      ) => {
        let next = 0;
        const capacity = Math.max(1, options.concurrency?.(t) ?? 1);
        await Promise.all(
          Array.from(
            { length: Math.min(values.length, capacity) },
            async () => {
              while (next < values.length) {
                signal.throwIfAborted();
                const value = values[next++];
                await run(value);
                signal.throwIfAborted();
              }
            },
          ),
        );
      };
      do {
        const page = await options.page(t, cursor, signal);
        signal.throwIfAborted();
        initial ??= page;
        if (
          (page.session.revert &&
            (drafts.restored || page.session.revert.messageID !== boundary)) ||
          page.clock.epoch !== initial.clock.epoch ||
          page.clock.seq !== initial.clock.seq
        ) {
          throw fail(
            t,
            "The conversation changed before its earlier branch could be saved. The replacement was not sent.",
            "Restore the pending conversation if needed, then retry Revert when it is settled.",
          );
        }
        const references = new Map<string, { source?: NativeSource }[]>();
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
            const group = references.get(source.ref) ?? [];
            group.push(holder);
            references.set(source.ref, group);
          }
        }
        await parallel([...references], async ([ref, holders]) => {
          const view = await options.source(t, ref, signal);
          signal.throwIfAborted();
          for (const holder of holders) {
            const { ref: _ref, ...saved } = holder.source!;
            holder.source = { ...saved, ...view };
          }
        });
        messages.push(...page.items);
        Object.assign(turns, page.turns);
        const entries = new Map<string, HistoryEntry>();
        await parallel(page.items.filter(isRealPrompt), async (message) => {
          const entry = await options.prompt(t, message.id, signal);
          signal.throwIfAborted();
          if (!entry) {
            throw fail(
              t,
              "An earlier prompt could not be saved exactly. The replacement was not sent.",
              "Restore access to the original prompt and its attachments, then retry.",
            );
          }
          entry.parts = await options.attachments(entry.parts, t.sidecarId);
          signal.throwIfAborted();
          entries.set(message.id, entry);
        });
        for (const message of page.items) {
          const entry = entries.get(message.id);
          if (entry) prompts.push({ messageID: message.id, entry });
        }
        cursor = page.older ?? undefined;
        if (cursor && seen.has(cursor)) {
          throw fail(
            t,
            "The earlier branch could not be read completely. The replacement was not sent.",
            "Reload this session, then retry Revert.",
          );
        }
        if (cursor) seen.add(cursor);
      } while (cursor);
      const final = await options.page(t, undefined, signal);
      signal.throwIfAborted();
      if (
        final.clock.epoch !== initial!.clock.epoch ||
        final.clock.seq !== initial!.clock.seq ||
        final.session.revert?.messageID !== initial!.session.revert?.messageID
      ) {
        throw fail(
          t,
          "The conversation changed while saving its earlier branch. The replacement was not sent.",
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
      const original = drafts.original;
      const branch: SavedBranch = {
        id: randomID(),
        boundary,
        created: Date.now(),
        session: initial!.session,
        messages: messages.sort(compareMessages),
        turns,
        prompts,
        drafts: [],
        pending: !drafts.restored,
        replaced: false,
        bytes: 0,
      };
      retain(
        branch,
        branchDraftLabels.beforeRevert,
        await materialize(original),
      );
      retain(branch, branchDraftLabels.atRevert, await materialize(before));
      if (drafts.restored) {
        retain(
          branch,
          branchDraftLabels.beforeRestore,
          await materialize(drafts.restored.current),
        );
      }
      signal.throwIfAborted();
      save(t, branch, false, true);
      if (
        drafts.restored?.edited && same(selected, t) &&
        !sameDraft(options.drafts.current(draftKey(t)), branch.drafts[0].value)
      ) {
        store.update((s) => {
          s.choice = {
            branchID: branch.id,
            label: branchDraftLabels.savedDraft,
            draft: cloneDraft(branch.drafts[0].value),
          };
        });
      }
    } finally {
      if (
        same(selected, t) &&
        captures.get(draftKey(t))?.controller.signal === signal
      ) {
        store.update((s) => {
          s.pending = false;
        });
      }
    }
  };
  const prepare = (
    t: Selection,
    boundary: string,
    retained?: CaptureDrafts,
  ): Promise<void> => {
    const key = draftKey(t), current = captures.get(key);
    if (current) return current.promise;
    const controller = new AbortController();
    const atRevert = cloneDraft(options.drafts.current(key));
    const drafts = retained ??
      {
        atRevert,
        original: options.drafts.reverts.get(key)?.before ?? atRevert,
      };
    const promise = Promise.resolve().then(() =>
      capture(t, boundary, controller.signal, drafts)
    ).catch((cause) => {
      if (controller.signal.aborted) return;
      const error = cause instanceof RequestFailure ? cause : fail(
        t,
        "The earlier branch could not be saved. The replacement was not sent.",
        "Restore access to the original history and browser storage, then retry Send or restore the conversation.",
      );
      failures.set(key, error);
      options.feedback?.(t).fail(error);
      if (same(selected, t)) {
        store.update((s) => {
          s.error = failureValue(error);
        });
      }
      throw error;
    }).finally(() => {
      // A failed page worker retires its siblings before another capture can
      // acquire this target. Late results still check this same lifetime.
      controller.abort();
      if (captures.get(key)?.controller === controller) captures.delete(key);
    });
    captures.set(key, { controller, promise, boundary, drafts });
    return promise;
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
        s.error = target && failures.has(draftKey(target))
          ? failureValue(failures.get(draftKey(target))!)
          : undefined;
        s.pending = !!target && captures.has(draftKey(target));
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
      await captures.get(draftKey(t))?.promise;
      const session = await options.session(t);
      if (!session.revert) return;
      let branch = load(t).find((b) => b.pending);
      // A reload can retire the in-memory capture, never the native staged tail.
      if (!branch) {
        await prepare(t, session.revert.messageID);
        branch = load(t).find((b) => b.pending);
      }
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
      const current = load(t).find((b) => b.id === branch!.id);
      if (current) retain(current, label, value);
      if (!current || !save(t, current)) {
        throw fail(
          t,
          "The earlier branch was deleted while preparing the replacement. The replacement was not sent.",
          "Retry Send to save the retained conversation again, or restore the conversation.",
        );
      }
    },
    async settled(t, restored = false) {
      if (!supportsHistory(t)) return;
      const previous = captures.get(draftKey(t));
      if (restored) {
        previous?.controller.abort();
        captures.delete(draftKey(t));
        clearFailure(t);
        if (same(selected, t)) {
          store.update((s) => {
            s.pending = false;
            s.error = undefined;
          });
        }
      }
      // Bookkeeping after native dispatch must never make an admitted send look
      // unsent. The complete pre-action archive already remains durable.
      try {
        let branch = load(t).find((b) => b.pending);
        if (!branch) {
          const transaction = options.drafts.reverts.get(draftKey(t));
          const boundary = previous?.boundary ?? transaction?.boundary;
          if (restored && boundary) {
            const current = cloneDraft(options.drafts.current(draftKey(t)));
            const drafts = previous?.drafts ??
              { original: transaction!.before, atRevert: current };
            // Restore retires the old stage, not the promised draft/archive copy.
            // Reacquire restored history under a fresh clock without blocking it.
            void prepare(t, boundary, {
              ...drafts,
              restored: {
                current,
                edited: transaction?.edited ??
                  !sameDraft(current, drafts.original),
              },
            }).catch(() => {});
          }
          return;
        }
        if (!restored && (await options.session(t)).revert) return;
        // Merge bookkeeping into the current stored copy, including any drafts
        // retained by reuse/choose while the session read was pending.
        branch = load(t).find((b) => b.id === branch!.id);
        if (!branch) {
          refresh(t);
          return;
        }
        if (restored) {
          retain(
            branch,
            branchDraftLabels.beforeRestore,
            options.drafts.current(draftKey(t)),
          );
        }
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
        if (!options.storage) {
          throw new Error("Browser persistence is unavailable");
        }
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
  storage:
    | Pick<
      Storage,
      "getItem" | "setItem" | "removeItem" | "key" | "length"
    >
    | null;
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
    feedback: (target) => rpc(target).feedback(target.sessionID),
    page: (target, before, signal) =>
      transcripts.snapshotPage(target, before, signal),
    concurrency: (target) =>
      resources.sidecars.connection(target.sidecarId).messages?.concurrency ??
        1,
    prompt: (target, messageID, signal) =>
      rpc(target).call("history.prompt", {
        sessionID: target.sessionID,
        messageID,
      }, { signal }),
    source: (target, ref, signal) =>
      rpc(target).call("source.get", { sessionID: target.sessionID, ref }, {
        signal,
      }),
    session: (target) =>
      rpc(target).call("session.get", { sessionID: target.sessionID }),
  });
}
