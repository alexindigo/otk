// SPDX-License-Identifier: LGPL-3.0-only
import { randomID } from "@otk/protocol";
import { isRealPrompt, MESSAGE_PAGE_SIZE } from "@otk/protocol";
import type {
  ContentSession,
  HistoryEntry,
  Message,
  MessagePage,
  NativeSource,
  NativeSourceView,
  PromptPart,
  RevertInfo,
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
import {
  type BranchArchive,
  packBranch,
  unpackBranch,
} from "./branch-archive-codec.ts";

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
  committedAt?: number;
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
  permanence?: {
    boundaryID: string;
    saving: boolean;
    error: FailureValue;
    causeID?: string;
  };
  recovery?: { boundaryID: string; restored: boolean };
}
export interface BranchSendPermit {
  target: Selection;
  record?: Pick<RevertInfo, "boundaryID" | "messageIDs">;
  discard?: boolean;
}
export interface BranchHistory {
  readonly state: BranchHistoryState;
  /** A capability limitation, not a failed preservation attempt. */
  preservationWarning(): string | undefined;
  select(target: Selection | undefined): void;
  /** Every archive acquisition is scoped by the staged revert's ID record. */
  prepare(
    target: Selection,
    boundary: string,
    record: RevertInfo,
  ): Promise<void>;
  beforeCommit(
    target: Selection,
    label?: string,
    permit?: BranchSendPermit,
    draft?: Draft,
  ): Promise<void>;
  beforeSend(target: Selection, captured?: Draft): Promise<BranchSendPermit>;
  saveCopy(): Promise<void>;
  retryCopy(): Promise<void>;
  keepWithoutCopy(): void;
  sendAnyway(): Promise<void>;
  cancelSend(target?: Selection): void;
  stageEnded(target: Selection): void;
  committed(target: Selection, boundaryID: string, at: number): void;
  restored(target: Selection): void;
  finished(target: Selection): readonly SavedBranch[];
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
  replaced?: boolean; // Legacy inference, never read as evidence.
  drafts: StoredDraft[];
};
const root = "otk.branch-history.v1/";
const same = (a: Selection | undefined, b: Selection) =>
  a?.sidecarId === b.sidecarId && a.sessionID === b.sessionID;
const draftKey = (t: Selection) => sessionKey(t.sidecarId, t.sessionID);
const occupied = (d: Draft) => hasDraftContent(d) || !!d.editor;
const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify(storedDraft("", a)) === JSON.stringify(storedDraft("", b));
export function savedBranchMatches(
  branch: SavedBranch,
  record: RevertInfo,
): boolean {
  return branch.pending && branch.boundary === record.boundaryID &&
    record.messageIDs.every((id) =>
      branch.messages.some((message) => message.id === id)
    );
}
export function isReplaced(branch: SavedBranch): boolean {
  return branch.committedAt !== undefined;
}
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
  // Keep the measurement outside the intern table: its digit count has a stable
  // fixed point even when it happens to equal another number in the content.
  const { bytes, ...content } = branch;
  return JSON.stringify({
    ...packBranch({
      ...content,
      schema: 1,
      drafts: branch.drafts.map((d) => storedDraft(d.label, d.value)),
    }),
    bytes,
  });
}
function decode(raw: string): SavedBranch {
  const parsed = JSON.parse(raw);
  const value = (parsed.schema === 2
    ? {
      ...unpackBranch(parsed as BranchArchive) as StoredBranch,
      ...(typeof parsed.bytes === "number" ? { bytes: parsed.bytes } : {}),
    }
    : parsed) as StoredBranch;
  if (
    value.schema !== 1 || typeof value.id !== "string" ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.prompts) || !Array.isArray(value.drafts) ||
    !value.session ||
    typeof value.boundary !== "string" || typeof value.created !== "number"
  ) {
    throw new Error("Invalid saved branch");
  }
  // Old archives retain real records: normalize the read projection by identity,
  // never by their old count, without rewriting the stored browser data.
  const revert = value.session.revert;
  const legacyBoundary = revert && Reflect.get(revert, "messageID");
  const at = value.messages.findIndex((m) => m.id === legacyBoundary);
  const session =
    revert && !revert.boundaryID && typeof legacyBoundary === "string"
      ? {
        ...value.session,
        revert: {
          boundaryID: legacyBoundary,
          messageIDs: at < 0 ? [] : value.messages.slice(at).map((m) => m.id),
          files: revert.files,
        },
      }
      : value.session;
  const { replaced: _legacy, committedAt, ...branch } = value;
  return {
    ...branch,
    ...(Number.isFinite(committedAt) ? { committedAt } : {}),
    session,
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
    scope?: import("@otk/protocol").MessageSnapshotScope,
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
  /** An acquired baseline is enough for pre-publication admission. Dispatch
   * still reads native state and validates the invocation's exact permit. */
  current?(target: Selection): ContentSession | undefined;
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
      record: RevertInfo;
    }
  >();
  // Revert identity and promised draft retention outlive individual capture jobs.
  const records = new Map<
    string,
    { record: RevertInfo; drafts: CaptureDrafts }
  >();
  const recoveries = new Map<
    string,
    NonNullable<BranchHistoryState["recovery"]>
  >();
  const publishRecovery = (t: Selection) => {
    if (same(selected, t)) {
      store.update((s) => {
        s.recovery = recoveries.get(draftKey(t));
      });
    }
  };
  const clearRecovery = (t: Selection) => {
    recoveries.delete(draftKey(t));
    publishRecovery(t);
  };
  const failures = new Map<string, RequestFailure>();
  type SendChoice = {
    target: Selection;
    record: RevertInfo;
    draft: Draft;
    choice: NonNullable<BranchHistoryState["permanence"]>;
    wait: ReturnType<typeof Promise.withResolvers<BranchSendPermit>>;
  };
  const sends = new Map<string, SendChoice>();
  const currentSend = (t = selected) => t && sends.get(draftKey(t));
  const ownsSend = (pending: SendChoice) =>
    currentSend(pending.target) === pending;
  const publishSend = (t: Selection) => {
    if (same(selected, t)) {
      store.update((s) => {
        s.permanence = currentSend(t)?.choice;
      });
    }
  };
  const retireSend = (pending: SendChoice): boolean => {
    if (!ownsSend(pending)) return false;
    const t = pending.target;
    sends.delete(draftKey(t));
    publishSend(t);
    return true;
  };
  const rejectSend = (pending: SendChoice) => {
    if (!retireSend(pending)) return;
    pending.wait.reject(
      new DOMException(
        "The staged revert changed or Send was canceled",
        "AbortError",
      ),
    );
  };
  const cancelSend = (t = selected) => {
    const pending = currentSend(t);
    if (pending) rejectSend(pending);
  };
  const matchesPermit = (
    t: Selection,
    permit: BranchSendPermit,
    record: RevertInfo | undefined,
  ) =>
    same(permit.target, t) &&
    permit.record?.boundaryID === record?.boundaryID &&
    JSON.stringify(permit.record?.messageIDs) ===
      JSON.stringify(record?.messageIDs);
  const allowSend = async (pending: SendChoice, discard: boolean) => {
    if (!ownsSend(pending)) return;
    const t = pending.target;
    const permit: BranchSendPermit = {
      target: pending.target,
      discard,
      record: {
        boundaryID: pending.record.boundaryID,
        messageIDs: [...pending.record.messageIDs],
      },
    };
    if (!matchesPermit(t, permit, (await options.session(t)).revert)) {
      rejectSend(pending);
      return;
    }
    if (!retireSend(pending)) return;
    clearFailure(t);
    clearRecovery(t);
    pending.wait.resolve(permit);
  };
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
    actionLabel = "Saving the earlier conversation",
    details?: string,
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
        details,
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
        "Saved earlier conversations could not be read. No stored data was changed.",
        "Check storage access, then reopen this session.",
        "Opening saved earlier conversations",
        "Browser localStorage is unavailable. No stored data was changed.",
      );
    }
  };
  const sendFailure = (target: Selection, cause: unknown) => {
    const facts = cause instanceof RequestFailure
      ? cause.failure.facts
      : undefined;
    const reason = facts?.reason ??
      "The earlier conversation has not been saved.";
    return failureValue(
      new RequestFailure({
        code: "revert.permanence",
        diagnosticID: randomID(),
        retry: "new-intent",
        facts: {
          actionLabel: "Sending makes the revert permanent",
          target,
          reason: reason +
            (reason.includes("The replacement was not sent.")
              ? ""
              : " The replacement was not sent."),
          recovery: "Save copy, Send anyway, or Cancel.",
          details: facts?.details,
        },
      }),
    );
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
    operation?: "restore" | "commit",
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
          "The earlier conversation is saved, but its latest status could not be saved. The native action already ran.",
          "Check storage access and free space, then reopen this session.",
          "Updating the earlier conversation",
        );
      }
      const quota = !!cause && typeof cause === "object" && "name" in cause &&
        cause.name === "QuotaExceededError";
      const outcome = operation === "restore"
        ? " The conversation was restored."
        : "";
      throw fail(
        t,
        quota
          ? `The earlier conversation couldn't be saved: storage is full.${outcome}`
          : `The earlier conversation couldn't be saved: storage is unavailable.${outcome}`,
        quota
          ? "Free space, then Retry, or Keep without a saved copy."
          : "Check storage access, then Retry, or Keep without a saved copy.",
        "Saving the earlier conversation",
        `Browser localStorage ${
          quota ? "is full" : "is unavailable"
        }. The earlier conversation and draft require ${branch.bytes.toLocaleString()} bytes (UTF-16, including the key).${
          quota
            ? " The quota is about 5 MB per origin. If this earlier conversation alone exceeds it, it cannot fit here."
            : ""
        } Older saved conversations were not removed.`,
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
    record: RevertInfo,
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
          drafts.restored
            ? "The earlier conversation couldn't be saved: storage is unavailable. The conversation was restored."
            : "The earlier conversation couldn't be saved: storage is unavailable.",
          "Check storage access, then Retry, or Keep without a saved copy.",
          "Saving the earlier conversation",
          "Browser localStorage is unavailable. The earlier conversation and draft were not saved. Older saved conversations were not removed.",
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
      if (
        pending && session?.revert &&
        savedBranchMatches(pending, record)
      ) return;
      for (const previous of existing.filter((b) => b.pending)) {
        previous.pending = false;
        save(t, previous);
      }
      let initial: MessagePage | undefined;
      const messages: Message[] = [],
        prompts: SavedBranch["prompts"] = [],
        turns: MessagePage["turns"] = {};
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
      const enrich = async (page: MessagePage) => {
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
        const entries: SavedBranch["prompts"] = [];
        await parallel(page.items.filter(isRealPrompt), async (message) => {
          const entry = await options.prompt(t, message.id, signal);
          signal.throwIfAborted();
          if (!entry) {
            throw new Error("An original prompt is no longer available");
          }
          entry.parts = await options.attachments(entry.parts, t.sidecarId);
          signal.throwIfAborted();
          entries.push({ messageID: message.id, entry });
        });
        return entries;
      };
      const backoff = async (attempt: number) => {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
          }, Math.min(1000, 100 * 2 ** attempt));
          signal.addEventListener("abort", stop, { once: true });
        });
      };
      let refreshCapture: (() => Promise<void>) | undefined;
      {
        const rows = new Map<string, Message>(),
          entries = new Map<string, HistoryEntry>(),
          revisions: Record<string, number> = {};
        const check = (page: MessagePage, ids: string[]) => {
          initial ??= page;
          if (
            page.clock.epoch !== initial.clock.epoch ||
            page.session.revert?.boundaryID !==
              initial.session.revert?.boundaryID ||
            (page.session.revert &&
              page.session.revert.boundaryID !== record.boundaryID) ||
            !page.revisions || ids.some((id) =>
              !Number.isSafeInteger(page.revisions![id]) ||
              page.revisions![id] < 0
            )
          ) {
            throw new Error("The staged archive epoch changed");
          }
        };
        const batches = function* (ids: string[]) {
          for (let at = 0; at < ids.length; at += MESSAGE_PAGE_SIZE) {
            yield ids.slice(at, at + MESSAGE_PAGE_SIZE);
          }
        };
        const acquire = async (ids: string[]) => {
          for (const batch of batches(ids)) {
            let attempt = 0;
            while (true) {
              try {
                const page = await options.page(t, undefined, signal, {
                  messageIDs: batch,
                });
                signal.throwIfAborted();
                check(page, batch);
                if (
                  page.items.length !== batch.length ||
                  batch.some((id) =>
                    !page.items.some((m) => m.id === id)
                  )
                ) throw new Error("A reverted record is no longer available");
                const prompts = await enrich(page);
                for (const item of page.items) rows.set(item.id, item);
                for (const id of batch) {
                  delete revisions[id];
                  entries.delete(id);
                  revisions[id] = page.revisions![id];
                }
                for (const item of prompts) {
                  entries.set(item.messageID, item.entry);
                }
                Object.assign(turns, page.turns);
                break;
              } catch (cause) {
                signal.throwIfAborted();
                if (attempt >= 3) throw cause;
                await backoff(attempt++);
              }
            }
          }
        };
        const validate = async () => {
          let attempt = 0;
          while (true) {
            try {
              const page = await options.page(t, undefined, signal, {
                messageIDs: record.messageIDs,
                validate: true,
              });
              signal.throwIfAborted();
              check(page, record.messageIDs);
              return record.messageIDs.filter((id) =>
                page.revisions![id] !== revisions[id]
              );
            } catch (cause) {
              signal.throwIfAborted();
              if (attempt >= 3) throw cause;
              await backoff(attempt++);
            }
          }
        };
        await acquire(record.messageIDs);
        refreshCapture = async () => {
          let attempt = 0;
          while (true) {
            const changed = await validate();
            if (!changed.length) break;
            if (attempt >= 3) {
              throw new Error("Reverted records are still changing");
            }
            await backoff(attempt++);
            await acquire(changed);
          }
          messages.length = 0;
          prompts.length = 0;
          for (const id of record.messageIDs) {
            messages.push(rows.get(id)!);
            const entry = entries.get(id);
            if (entry) prompts.push({ messageID: id, entry });
          }
        };
        await refreshCapture();
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
        messages,
        turns,
        prompts,
        drafts: [],
        pending: !drafts.restored,
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
      await refreshCapture?.();
      signal.throwIfAborted();
      save(t, branch, false, true, drafts.restored ? "restore" : undefined);
      clearRecovery(t);
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
    record: RevertInfo,
    retained?: CaptureDrafts,
  ): Promise<void> => {
    // Typed callers cannot omit the record; untyped view data is still checked.
    if (
      !record || record.boundaryID !== boundary || !record.messageIDs.length ||
      !record.messageIDs.includes(boundary) ||
      new Set(record.messageIDs).size !== record.messageIDs.length
    ) {
      return Promise.reject(
        fail(
          t,
          "The earlier conversation has no valid revert identity record. No saved copy was acquired.",
          "Reopen the staged revert before retrying the copy.",
        ),
      );
    }
    // Framework views may pass proxies, as with captured drafts. Own the JSON
    // record rather than retaining view state or asking structuredClone for it.
    record = JSON.parse(JSON.stringify(record)) as RevertInfo;
    const key = draftKey(t), current = captures.get(key);
    if (sends.has(key) && sends.get(key)!.record.boundaryID !== boundary) {
      cancelSend(t);
    }
    if (
      current?.boundary === boundary &&
      JSON.stringify(current.record.messageIDs) ===
        JSON.stringify(record.messageIDs)
    ) return current.promise;
    current?.controller.abort();
    const controller = new AbortController();
    const atRevert = cloneDraft(options.drafts.current(key));
    const drafts = retained ??
      {
        atRevert,
        original: options.drafts.reverts.get(key)?.before ?? atRevert,
      };
    records.set(key, { record, drafts });
    const captureRecord = record;
    const promise = Promise.resolve().then(() =>
      capture(t, boundary, controller.signal, drafts, captureRecord)
    ).catch((cause) => {
      if (controller.signal.aborted) return;
      const error = cause instanceof RequestFailure ? cause : fail(
        t,
        drafts.restored
          ? "The earlier conversation couldn't be saved. The conversation was restored."
          : "The earlier conversation couldn't be saved.",
        "Check history and storage access, then Retry, or Keep without a saved copy.",
        "Saving the earlier conversation",
      );
      recoveries.set(key, {
        boundaryID: boundary,
        restored: !!drafts.restored,
      });
      publishRecovery(t);
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
    captures.set(key, { controller, promise, boundary, drafts, record });
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
  const owner: BranchHistory = {
    state: store.state,
    preservationWarning: () => {
      const target = store.state.target;
      return target && !supportsHistory(target)
        ? "This branch can't be kept after you send (this server doesn't provide prompt history)."
        : undefined;
    },
    subscribe: (listener) => store.subscribe(listener),
    finished(t) {
      try {
        const branches = same(selected, t) ? store.state.branches : load(t);
        return branches.filter((branch) => !branch.pending);
      } catch {
        return []; // The owner already reported the storage failure.
      }
    },
    select(target) {
      if (target && same(selected, target)) return;
      selected = target && { ...target };
      store.update((s) => {
        s.target = selected;
        s.opened = undefined;
        s.choice = undefined;
        s.permanence = target ? sends.get(draftKey(target))?.choice : undefined;
        s.recovery = target ? recoveries.get(draftKey(target)) : undefined;
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
    async beforeCommit(
      t,
      label: string = branchDraftLabels.beforeSending,
      permit,
      draft,
    ) {
      if (permit) {
        const record = (await options.session(t)).revert;
        if (!matchesPermit(t, permit, record)) {
          throw new DOMException(
            "The staged revert changed before Send",
            "AbortError",
          );
        }
        if (
          record && !permit.discard &&
          !load(t).some((branch) => savedBranchMatches(branch, record))
        ) {
          throw fail(
            t,
            "The saved copy was removed before Send. The replacement was not sent.",
            "Retry Send to save a copy or explicitly choose Send anyway.",
          );
        }
        return;
      }
      if (!supportsHistory(t)) return;
      await captures.get(draftKey(t))?.promise;
      const session = await options.session(t);
      if (!session.revert) return;
      let branch = load(t).find((b) => savedBranchMatches(b, session.revert!));
      // A reload can retire the in-memory capture, never the native staged tail.
      if (!branch) {
        await prepare(t, session.revert.boundaryID, session.revert);
        branch = load(t).find((b) => savedBranchMatches(b, session.revert!));
      }
      if (!branch) {
        throw fail(
          t,
          "The earlier conversation has not been saved. The replacement was not sent.",
          "Use Restore conversation first, then revert again to save it.",
        );
      }
      const value = cloneDraft(draft ?? options.drafts.current(draftKey(t)));
      const parts = await options.attachments(
        value.chips.map((c) => c.part),
        t.sidecarId,
      );
      value.chips = value.chips.map((c, i) => ({ ...c, part: parts[i] }));
      const current = load(t).find((b) => b.id === branch!.id);
      if (current) retain(current, label, value);
      if (!current || !save(t, current, false, false, "commit")) {
        throw fail(
          t,
          "The saved earlier conversation was deleted while preparing the replacement. The replacement was not sent.",
          "Retry Send to save the retained conversation again, or restore the conversation.",
        );
      }
    },
    async beforeSend(t, captured) {
      const target = { ...t },
        draft = cloneDraft(captured ?? options.drafts.current(draftKey(t))),
        record = (options.current?.(t) ?? await options.session(t)).revert;
      const permit: BranchSendPermit = {
        target,
        record: record &&
          { boundaryID: record.boundaryID, messageIDs: [...record.messageIDs] },
      };
      if (!record) return permit;
      if (sends.has(draftKey(t))) {
        throw new DOMException("A Send choice is already open", "AbortError");
      }
      try {
        if (!supportsHistory(t)) {
          throw new Error("This server does not provide prompt history");
        }
        await owner.beforeCommit(t, undefined, undefined, draft);
        if (!matchesPermit(t, permit, (await options.session(t)).revert)) {
          throw new DOMException("The staged revert changed", "AbortError");
        }
        return permit;
      } catch (cause) {
        if (!matchesPermit(t, permit, (await options.session(t)).revert)) {
          throw new DOMException("The staged revert changed", "AbortError");
        }
        if (sends.has(draftKey(t))) {
          throw new DOMException("A Send choice is already open", "AbortError");
        }
        const wait = Promise.withResolvers<BranchSendPermit>();
        const choice = {
          boundaryID: record.boundaryID,
          saving: false,
          error: sendFailure(target, cause),
          causeID: cause instanceof RequestFailure
            ? cause.failure.diagnosticID
            : undefined,
        };
        sends.set(draftKey(t), { target, record, draft, choice, wait });
        publishSend(t);
        return await wait.promise;
      }
    },
    async saveCopy() {
      const pending = currentSend();
      if (!pending || pending.choice.saving) return;
      pending.choice = { ...pending.choice, saving: true };
      publishSend(pending.target);
      try {
        if (!supportsHistory(pending.target)) {
          throw new Error("This server does not provide prompt history");
        }
        await owner.beforeCommit(
          pending.target,
          undefined,
          undefined,
          pending.draft,
        );
        await allowSend(pending, false);
      } catch (cause) {
        if (ownsSend(pending)) {
          pending.choice = {
            ...pending.choice,
            error: sendFailure(pending.target, cause),
            causeID: cause instanceof RequestFailure
              ? cause.failure.diagnosticID
              : undefined,
          };
        }
      } finally {
        if (ownsSend(pending)) {
          pending.choice = { ...pending.choice, saving: false };
          publishSend(pending.target);
        }
      }
    },
    async retryCopy() {
      const t = selected && { ...selected };
      const retained = t && records.get(draftKey(t));
      if (!t || !retained) return;
      await prepare(
        t,
        retained.record.boundaryID,
        retained.record,
        retained.drafts,
      );
    },
    keepWithoutCopy() {
      if (!selected) return;
      clearFailure(selected);
      clearRecovery(selected);
      store.update((s) => {
        s.error = undefined;
      });
    },
    async sendAnyway() {
      const pending = currentSend();
      if (pending) await allowSend(pending, true);
    },
    cancelSend,
    stageEnded(t) {
      try {
        for (const branch of load(t)) {
          if (!branch.pending) continue;
          branch.pending = false;
          save(t, branch, true);
        }
      } catch { /* Storage failures are published by the archive owner. */ }
    },
    committed(t, boundaryID, at) {
      if (sends.get(draftKey(t))?.record.boundaryID === boundaryID) {
        cancelSend(t);
      }
      try {
        const branch = load(t).find((b) => b.boundary === boundaryID);
        if (
          !branch || isReplaced(branch) ||
          (branch.session.revertCommitted?.at ?? -Infinity) >= at
        ) return;
        branch.pending = false;
        branch.committedAt = at;
        save(t, branch, true);
      } catch {
        /* A native fact cannot roll back the user's admitted action. */
      }
    },
    restored(t) {
      cancelSend(t);
      if (!supportsHistory(t)) return;
      const previous = captures.get(draftKey(t));
      const retained = records.get(draftKey(t));
      previous?.controller.abort();
      captures.delete(draftKey(t));
      clearFailure(t);
      clearRecovery(t);
      if (same(selected, t)) {
        store.update((s) => {
          s.pending = false;
          s.error = undefined;
        });
      }
      // Bookkeeping after native dispatch must never make an admitted send look
      // unsent. The complete pre-action archive already remains durable.
      try {
        const branch = load(t).find((b) => b.pending);
        if (!branch) {
          const transaction = options.drafts.reverts.get(draftKey(t));
          const record = retained?.record;
          if (record) {
            const current = cloneDraft(options.drafts.current(draftKey(t)));
            const drafts = retained.drafts;
            // Restore retires the old stage, not the promised draft/archive copy.
            // Reacquire restored history under a fresh clock without blocking it.
            void prepare(t, record.boundaryID, record, {
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
        retain(
          branch,
          branchDraftLabels.beforeRestore,
          options.drafts.current(draftKey(t)),
        );
        branch.pending = false;
        if (!save(t, branch, true)) return;
        const transaction = options.drafts.reverts.get(draftKey(t));
        const original = branch.drafts[0]?.value;
        if (
          transaction?.edited && original && same(selected, t) &&
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
          "The earlier conversation is saved, but its latest status could not be confirmed. The native action already ran.",
          "Check the connection and storage access, then reopen this session.",
          "Updating the earlier conversation",
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
          actionLabel: "Using a saved earlier conversation",
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
          "The saved earlier conversation was not deleted: storage is unavailable.",
          "Check storage access, then retry Delete.",
          "Deleting the saved earlier conversation",
          "Browser localStorage is unavailable. No stored data was changed.",
        );
      }
      store.update((s) => {
        if (s.choice?.branchID === id) s.choice = undefined;
      });
      refresh(selected);
    },
  };
  return owner;
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
    page: (target, before, signal, scope) =>
      transcripts.snapshotPage(target, before, signal, scope),
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
      rpc(target).call("session.get", {
        sessionID: target.sessionID,
        purpose: "send",
      }),
    current: (target) => {
      const state = transcripts.get(target)?.state;
      return state?.info && state.continuity === "ready" && !state.loading &&
          resources.sidecars.connection(target.sidecarId).connected
        ? { ...state.info, revert: state.content.revert ?? undefined }
        : undefined;
    },
  });
}
