// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AssistantMessage,
  ContentOp,
  Message,
  Part,
  ReplyBoundary,
} from "@otk/protocol";
import {
  compareMessages,
  isAssistantTerminal,
  isRealPrompt,
} from "@otk/protocol";
import { reduceMessage } from "./reduce.ts";
import { retainStreamMessage } from "./stream-last-good.ts";
import {
  createRecordProjection,
  type RecordProjection,
} from "./activity-spans.ts";

export interface TranscriptReply {
  key: string;
  firstID: string;
  lastID: string;
  messageIDs: string[];
  segments: {
    messageID: string;
    turnID?: string;
    parts: Part[];
    agent?: string;
    model?: AssistantMessage["model"];
    time?: AssistantMessage["time"];
  }[];
  message: Message;
  pending?: boolean;
  revision: number;
}
export interface TranscriptProjectionState {
  /** New canonical tail rows, independent of paging, geometry and part edits. */
  appendRevision: number;
  messageIDs: string[];
  messagesByID: Record<string, Message>;
  replyIDs: string[];
  repliesByID: Record<string, TranscriptReply>;
  queuedIDs: Set<string>;
  records: RecordProjection;
}
export const replyKey = (message: Message): string =>
  (message.role === "assistant" ||
      message.role === "context" && message.replyTo !== undefined)
    ? `reply:${message.replyTo ?? message.id}`
    : message.id;
const compare = compareMessages;
const dictionary = <T>(): Record<string, T> => Object.create(null);
/** Explicit neutral activity facts, shared by queue admission and presentation. */
export function hasActiveRecord(message: Message): boolean {
  return message.role === "context" &&
    message.parts.some((part) =>
      part.kind === "external" && part.activity?.state?.facts.active === true
    );
}
function insert(
  ids: string[],
  id: string,
  read: (id: string) => Message,
): string[] {
  const result = [...ids];
  let low = 0, high = result.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(read(result[middle]), read(id)) < 0) low = middle + 1;
    else high = middle;
  }
  result.splice(low, 0, id);
  return result;
}
/** Sole canonical body and grouping owner. Compatibility arrays are explicit lazy reads. */
export interface TranscriptProjection {
  readonly state: TranscriptProjectionState;
  messages(): Message[];
  clear(): void;
  replace(messages: readonly Message[]): void;
  merge(messages: readonly Message[]): void;
  retain(ids: Set<string>): void;
  boundaries(values: readonly ReplyBoundary[]): void;
  boundary(turnID: string): ReplyBoundary | undefined;
  busy(value: boolean): boolean;
  apply(op: ContentOp): boolean;
  helpers(
    read: (id: string) => import("@otk/protocol").HelperSummary | undefined,
  ): boolean;
  usesMetadata(ids: ReadonlySet<string>): boolean;
}
export function createTranscriptProjection(): TranscriptProjection {
  const records = createRecordProjection();
  const state: TranscriptProjectionState = {
    appendRevision: 0,
    messageIDs: [],
    messagesByID: dictionary<Message>(),
    replyIDs: [],
    repliesByID: dictionary<TranscriptReply>(),
    queuedIDs: new Set(),
    records: records.reconcile([], {}),
  };
  const parts = new Map<string, Map<string, number>>();
  let replacing = false;
  const helperLinks = new Map<string, Map<string, string>>();
  const helperChildren = new Map<string, number>();
  const helperPart = (message: string, part: string, value?: Part) => {
    const links = helperLinks.get(message) ?? new Map<string, string>();
    const previous = links.get(part);
    const next = value?.kind === "tool" && value.call.tool === "task"
      ? value.call.childSessionID
      : undefined;
    if (previous !== next) {
      if (previous) {
        const count = helperChildren.get(previous)! - 1;
        if (count) helperChildren.set(previous, count);
        else helperChildren.delete(previous);
      }
      if (next) helperChildren.set(next, (helperChildren.get(next) ?? 0) + 1);
    }
    if (
      value?.kind === "tool" && value.call.tool === "task" &&
      value.call.childSessionID
    ) links.set(part, value.call.childSessionID);
    else links.delete(part);
    if (links.size) helperLinks.set(message, links);
    else helperLinks.delete(message);
  };
  const clearHelper = (message: string) => {
    for (const part of helperLinks.get(message)?.keys() ?? []) {
      helperPart(message, part);
    }
  };
  const boundaries = new Map<string, ReplyBoundary>();
  const lastHeaders = new Map<string, Message>();
  const assistantHeaders = new Map<string, AssistantMessage>();
  const segmentByID = new Map<string, TranscriptReply["segments"][number]>();
  const locations = new Map<string, { key: string; index: number }>();
  const partReads = new Map<string, () => Part[]>();
  const answers = new Map<string, number>();
  const userClocks = new Map<string, number>(),
    unfinishedClocks = new Map<string, number>();
  const pendingTurns = new Set<string>(),
    pendingUsers = new Set<string>(),
    touched = new Set<string>();
  let userOrder: string[] = [], unfinishedOrder: string[] = [];
  let busy = false, detached: Message[] | undefined;
  let recordOrder: readonly string[] | undefined, recordsDirty = true;
  const read = (id: string) => state.messagesByID[id];
  const boundary = () => {
    const id = unfinishedOrder.at(-1);
    return id === undefined ? Infinity : unfinishedClocks.get(id)!;
  };
  const ordered = (ids: string[], id: string, clocks: Map<string, number>) => {
    const result = [...ids];
    let low = 0, high = result.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const order = clocks.get(result[mid])! - clocks.get(id)! ||
        result[mid].localeCompare(id);
      if (order < 0) low = mid + 1;
      else high = mid;
    }
    result.splice(low, 0, id);
    return result;
  };
  const userAfter = (time: number) => {
    let low = 0, high = userOrder.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (userClocks.get(userOrder[mid])! <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const header = (previous: Message | undefined, next: Message | undefined) => {
    const oldTurn = previous?.role === "assistant"
      ? previous.replyTo
      : undefined;
    const newTurn = next?.role === "assistant" ? next.replyTo : undefined;
    const oldUnfinished = previous && ((previous.role === "assistant" &&
      !isAssistantTerminal(previous)) || hasActiveRecord(previous));
    const newUnfinished = next && ((next.role === "assistant" &&
      !isAssistantTerminal(next)) || hasActiveRecord(next));
    if (
      previous?.role === next?.role &&
      previous?.time.created === next?.time.created &&
      previous?.sourceOrder === next?.sourceOrder &&
      (previous?.role !== "user" || next?.role !== "user" ||
        previous.origin === next.origin) &&
      oldTurn === newTurn &&
      oldUnfinished === newUnfinished
    ) return;
    const before = boundary(), current = userOrder.at(-1);
    if (oldTurn !== newTurn) {
      if (oldTurn !== undefined) {
        const count = answers.get(oldTurn)! - 1;
        if (count) answers.set(oldTurn, count);
        else answers.delete(oldTurn);
        touched.add(oldTurn);
      }
      if (newTurn !== undefined) {
        answers.set(newTurn, (answers.get(newTurn) ?? 0) + 1);
        touched.add(newTurn);
      }
    }
    if (previous && isRealPrompt(previous)) {
      userClocks.delete(previous.id);
      userOrder = userOrder.filter((id) => id !== previous.id);
      touched.add(previous.id);
    }
    if (next && isRealPrompt(next)) {
      userClocks.set(next.id, next.sourceOrder ?? next.time.created);
      userOrder = ordered(userOrder, next.id, userClocks);
      touched.add(next.id);
    }
    if (oldUnfinished) {
      unfinishedClocks.delete(previous!.id);
      unfinishedOrder = unfinishedOrder.filter((id) => id !== previous!.id);
    }
    if (newUnfinished) {
      unfinishedClocks.set(next!.id, next!.sourceOrder ?? next!.time.created);
      unfinishedOrder = ordered(unfinishedOrder, next!.id, unfinishedClocks);
    }
    const after = boundary(), selected = userOrder.at(-1);
    if (current !== selected) {
      if (current !== undefined) touched.add(current);
      if (selected !== undefined) touched.add(selected);
    }
    if (busy && before !== after) {
      const first = userAfter(Math.min(before, after)),
        end = userAfter(Math.max(before, after));
      for (let i = first; i < end; i++) touched.add(userOrder[i]);
    }
  };
  const orderGroup = (key: string) => {
    const position = (key: string) => {
      const message = read(state.repliesByID[key].messageIDs[0]);
      const prompt = message.role !== "user" && message.replyTo
        ? read(message.replyTo)
        : undefined;
      const anchor = prompt && compare(message, prompt) < 0
        ? prompt
        : undefined;
      return { message: anchor ?? message, reply: anchor ? 1 : 0 };
    };
    const target = position(key);
    const keys = state.replyIDs.filter((id) => id !== key);
    let low = 0, high = keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1, other = position(keys[mid]);
      if (
        (compare(other.message, target.message) || other.reply - target.reply) <
          0
      ) low = mid + 1;
      else high = mid;
    }
    keys.splice(low, 0, key);
    state.replyIDs = keys;
  };
  const group = (
    key: string,
    ids: string[],
    changed?: Message,
    reordered = false,
  ) => {
    const previous = state.repliesByID[key];
    if (!ids.length) {
      const turn = previous?.message.role === "assistant"
        ? previous.message.replyTo
        : undefined;
      if (turn !== undefined && pendingTurns.delete(turn)) touched.add(turn);
      lastHeaders.delete(key);
      assistantHeaders.delete(key);
      partReads.delete(key);
      delete state.repliesByID[key];
      state.replyIDs = state.replyIDs.filter((id) => id !== key);
      return;
    }
    const first = previous?.messageIDs[0] === ids[0] && changed?.id !== ids[0]
      ? previous.message
      : read(ids[0]);
    const last =
      previous?.messageIDs.at(-1) === ids.at(-1) && changed?.id !== ids.at(-1)
        ? lastHeaders.get(key)!
        : read(ids.at(-1)!);
    lastHeaders.set(key, last);
    // Source position and assistant reply authority are independent. Membership
    // changes may inspect this group; ordinary parts retain the indexed header.
    let assistant = assistantHeaders.get(key);
    if (
      !previous || previous.messageIDs !== ids ||
      (changed?.id === assistant?.id && changed?.role !== "assistant")
    ) {
      assistant = undefined;
      for (let i = ids.length - 1; i >= 0; i--) {
        const member = read(ids[i]);
        if (member.role === "assistant") {
          assistant = member;
          break;
        }
      }
    } else if (
      changed?.role === "assistant" &&
      (!assistant || changed.id === assistant.id ||
        compare(assistant, changed) < 0)
    ) {
      assistant = changed;
    }
    if (assistant) assistantHeaders.set(key, assistant);
    else assistantHeaders.delete(key);
    let segments: TranscriptReply["segments"];
    const location = changed && locations.get(changed.id);
    if (previous?.messageIDs === ids && changed && location?.key === key) {
      const segment = segmentByID.get(changed.id)!;
      segments = previous.segments;
      if (segments[location.index] !== segment) {
        segments = [...segments];
        segments[location.index] = segment;
      }
    } else {
      segments = ids.map((id, index) => {
        locations.set(id, { key, index });
        return segmentByID.get(id)!;
      });
    }
    // Flatten only this changed reply on explicit parts access. Historical groups stay untouched.
    let readParts = partReads.get(key);
    if (!readParts || segments !== previous?.segments) {
      let flat: Part[] | undefined;
      readParts = () => flat ??= segments.flatMap((segment) => segment.parts);
      partReads.set(key, readParts);
    }
    const partsForReply = readParts;
    const authority = assistant ?? last;
    const message: Message = {
      ...authority,
      id: first.id,
      sourceOrder: first.sourceOrder,
      time: { ...authority.time },
      get parts() {
        return partsForReply();
      },
    };
    const oldTurn = previous?.message.role === "assistant"
      ? previous.message.replyTo
      : undefined;
    const newTurn = message.role === "assistant" ? message.replyTo : undefined;
    if (
      oldTurn !== undefined && oldTurn !== newTurn &&
      pendingTurns.delete(oldTurn)
    ) touched.add(oldTurn);
    if (message.role === "assistant") {
      message.interrupted = !!(previous?.message.role === "assistant" &&
        previous.message.interrupted) || message.interrupted;
      message.error ??= previous?.message.role === "assistant"
        ? previous.message.error
        : undefined;
      if (message.replyTo !== undefined) {
        const pending = !isAssistantTerminal(message);
        if (pendingTurns.has(message.replyTo) !== pending) {
          if (pending) pendingTurns.add(message.replyTo);
          else pendingTurns.delete(message.replyTo);
          touched.add(message.replyTo);
        }
      }
    }
    const boundary = message.role === "assistant"
      ? boundaries.get(message.replyTo ?? message.id)
      : undefined;
    state.repliesByID[key] = {
      key,
      firstID: boundary?.firstID ?? first.id,
      lastID: boundary?.lastID &&
          (!previous || previous.lastID !== previous.messageIDs.at(-1))
        ? boundary.lastID
        : last.id,
      messageIDs: ids,
      segments,
      message,
      pending: previous?.pending,
      revision: (previous?.revision ?? 0) + 1,
    };
    state.records = records.update(key, state.repliesByID[key].revision);
    if (
      !previous || previous.messageIDs[0] !== ids[0] ||
      changed?.id === ids[0] && reordered
    ) orderGroup(key);
  };
  const queues = () => {
    const current = userOrder.at(-1), cutoff = boundary();
    let queued = state.queuedIDs;
    for (const id of touched) {
      const created = userClocks.get(id);
      const inQueue = busy && created !== undefined && created > cutoff &&
        !answers.has(id);
      if (queued.has(id) !== inQueue) {
        if (queued === state.queuedIDs) queued = new Set(queued);
        if (inQueue) queued.add(id);
        else queued.delete(id);
      }
      const previous = state.repliesByID[id];
      const value = busy && created !== undefined &&
        (id === current || inQueue || pendingTurns.has(id));
      if (value) pendingUsers.add(id);
      else pendingUsers.delete(id);
      if (previous && previous.pending !== value) {
        state.repliesByID[id] = { ...previous, pending: value };
      }
    }
    state.queuedIDs = queued;
    touched.clear();
    if (recordsDirty || recordOrder !== state.replyIDs) {
      state.records = records.reconcile(state.replyIDs, state.repliesByID);
      recordOrder = state.replyIDs;
      recordsDirty = false;
    }
  };
  const put = (message: Message, preservePartIndex = false) => {
    const previous = read(message.id),
      oldKey = previous && replyKey(previous),
      key = replyKey(message);
    if (previous === message) return;
    const last = read(state.messageIDs.at(-1) ?? "");
    if (!replacing && !previous && last && compare(last, message) < 0) {
      state.appendRevision++;
    }
    if (previous?.role === "context" || message.role === "context") {
      recordsDirty = true;
    }
    header(previous, message);
    state.messagesByID[message.id] = message;
    if (!preservePartIndex && previous?.parts !== message.parts) {
      clearHelper(message.id);
      for (const part of message.parts) helperPart(message.id, part.id, part);
      parts.set(
        message.id,
        new Map(message.parts.map((part, i) => [part.id, i])),
      );
    }
    const segment = segmentByID.get(message.id);
    const agent = message.role === "assistant" ? message.agent : undefined;
    const model = message.role === "assistant" ? message.model : undefined;
    const time = message.role === "assistant" ? message.time : undefined;
    const turnID = message.role === "assistant"
      ? message.replyTo ?? message.id
      : undefined;
    if (
      segment?.parts !== message.parts || segment?.agent !== agent ||
      segment?.time !== time || segment?.model !== model ||
      segment?.turnID !== turnID
    ) {
      segmentByID.set(message.id, {
        messageID: message.id,
        turnID,
        parts: message.parts,
        agent,
        model,
        time,
      });
    }
    const reordered = !previous || compare(previous, message) !== 0;
    if (reordered) {
      state.messageIDs = insert(
        state.messageIDs.filter((id) => id !== message.id),
        message.id,
        read,
      );
    }
    if (oldKey && oldKey !== key) {
      group(
        oldKey,
        state.repliesByID[oldKey].messageIDs.filter((id) => id !== message.id),
      );
    }
    const ids = state.repliesByID[key]?.messageIDs ?? [];
    const location = locations.get(message.id);
    const causalKey = message.role === "user" && reordered &&
        state.repliesByID[`reply:${message.id}`]
      ? `reply:${message.id}`
      : undefined;
    // Its effective position changes with the prompt. Remove it before binary
    // insertion so the remaining group order is still a sorted search space.
    if (causalKey) {
      state.replyIDs = state.replyIDs.filter((id) => id !== causalKey);
    }
    group(
      key,
      location?.key === key && !reordered
        ? ids
        : insert(ids.filter((id) => id !== message.id), message.id, read),
      message,
      reordered,
    );
    // An earlier failure may already refer to this still-queued prompt. Only
    // reposition its one reply group, never traverse historical messages.
    if (causalKey) orderGroup(causalKey);
    detached = undefined;
  };
  const remove = (id: string) => {
    const previous = read(id);
    if (!previous) return;
    if (previous.role === "context") recordsDirty = true;
    header(previous, undefined);
    const key = replyKey(previous);
    const causalKey =
      previous.role === "user" && state.repliesByID[`reply:${id}`]
        ? `reply:${id}`
        : undefined;
    if (causalKey) {
      state.replyIDs = state.replyIDs.filter((key) => key !== causalKey);
    }
    delete state.messagesByID[id];
    parts.delete(id);
    clearHelper(id);
    segmentByID.delete(id);
    locations.delete(id);
    state.messageIDs = state.messageIDs.filter((key) => key !== id);
    group(key, state.repliesByID[key].messageIDs.filter((key) => key !== id));
    if (causalKey) orderGroup(causalKey);
    detached = undefined;
  };
  const owner = {
    state,
    boundary: (turnID: string) => boundaries.get(turnID),
    messages: (): Message[] => detached ??= state.messageIDs.map(read),
    usesMetadata: (ids: ReadonlySet<string>) => {
      for (const id of ids) if (helperChildren.has(id)) return true;
      return false;
    },
    clear(resetRecords = true) {
      state.messageIDs = [];
      state.messagesByID = dictionary<Message>();
      state.replyIDs = [];
      state.repliesByID = dictionary<TranscriptReply>();
      state.queuedIDs = new Set();
      if (resetRecords) {
        records.clear();
        state.records = records.reconcile([], {});
      }
      recordOrder = undefined;
      recordsDirty = true;
      parts.clear();
      helperLinks.clear();
      helperChildren.clear();
      boundaries.clear();
      lastHeaders.clear();
      assistantHeaders.clear();
      segmentByID.clear();
      locations.clear();
      partReads.clear();
      answers.clear();
      userClocks.clear();
      unfinishedClocks.clear();
      pendingTurns.clear();
      pendingUsers.clear();
      touched.clear();
      userOrder = [];
      unfinishedOrder = [];
      detached = undefined;
    },
    replace(messages: readonly Message[]) {
      const previous = state.messagesByID;
      const last = read(state.messageIDs.at(-1) ?? "");
      owner.clear(false);
      replacing = true;
      try {
        for (const message of messages) {
          put(retainStreamMessage(previous[message.id], message));
        }
      } finally {
        replacing = false;
      }
      const next = read(state.messageIDs.at(-1) ?? "");
      if (last && next && !previous[next.id] && compare(last, next) < 0) {
        state.appendRevision++;
      }
      queues();
    },
    merge(messages: readonly Message[]) {
      for (const message of messages) if (!read(message.id)) put(message);
      queues();
    },
    retain(ids: Set<string>) {
      for (const id of state.messageIDs) if (!ids.has(id)) remove(id);
      queues();
    },
    boundaries(values: readonly ReplyBoundary[]) {
      for (const value of values) {
        boundaries.set(value.turnID, value);
        const key = `reply:${value.turnID}`, reply = state.repliesByID[key];
        if (reply) {
          const knownLast = value.lastID && read(value.lastID),
            last = lastHeaders.get(key);
          state.repliesByID[key] = {
            ...reply,
            firstID: value.firstID ?? reply.firstID,
            lastID: knownLast && last && compare(last, knownLast) > 0
              ? last.id
              : value.lastID ?? reply.lastID,
          };
        }
      }
    },
    busy(value: boolean) {
      const changed = busy !== value;
      if (busy !== value) {
        busy = value;
        for (const id of pendingUsers) touched.add(id);
        if (value) {
          const current = userOrder.at(-1);
          if (current !== undefined) touched.add(current);
          for (const id of pendingTurns) touched.add(id);
          for (let i = userAfter(boundary()); i < userOrder.length; i++) {
            if (!answers.has(userOrder[i])) touched.add(userOrder[i]);
          }
        }
        queues();
      }
      return changed;
    },
    apply(op: ContentOp): boolean {
      if (op.op === "agent.colors") {
        for (const id of state.messageIDs) {
          const message = read(id);
          if (message.role === "context") continue;
          put({
            ...message,
            agentColor: message.agent === undefined
              ? undefined
              : op.colors[message.agent],
          });
        }
        return true;
      }
      if (op.op === "message.remove") {
        records.retire(op.messageID);
        remove(op.messageID);
        queues();
        return true;
      }
      if (
        op.op !== "message.upsert" && op.op !== "part.upsert" &&
        op.op !== "part.remove" && op.op !== "part.blocks" &&
        op.op !== "task.progress" && op.op !== "message.clock"
      ) return false;
      const id = op.op === "message.upsert" ? op.message.id : op.messageID;
      const previous = read(id);
      const slot = op.op === "message.upsert" || op.op === "message.clock"
        ? undefined
        : parts.get(id)?.get(
          op.op === "part.upsert" ? op.part.id : op.partID,
        ) ?? -1;
      const next = reduceMessage(previous, op, slot);
      if (next && next !== previous) {
        if (op.op === "part.upsert") helperPart(id, op.part.id, op.part);
        put(
          next,
          op.op === "part.blocks" || op.op === "task.progress" ||
            (op.op === "part.upsert" && slot !== undefined && slot >= 0),
        );
        queues();
      }
      return true;
    },
    helpers(
      read: (id: string) => import("@otk/protocol").HelperSummary | undefined,
    ): boolean {
      let changed = false;
      for (const [messageID, links] of helperLinks) {
        for (const [partID, childSessionID] of links) {
          const summary = read(childSessionID);
          if (!summary) continue;
          const previous = state.messagesByID[messageID];
          const next = reduceMessage(previous, {
            op: "task.progress",
            messageID,
            partID,
            childSessionID,
            summary,
          }, parts.get(messageID)?.get(partID));
          if (next && next !== previous) {
            put(next, true);
            changed = true;
          }
        }
      }
      return changed;
    },
  };
  return owner;
}
/** Detached multi-session compatibility input stays partitioned by session identity. */
export function projectReplies(
  messages: readonly Message[],
  busy = false,
): TranscriptReply[] {
  const sessions = new Map<string, Message[]>();
  const positions = new Map(
    messages.map((
      message,
      index,
    ) => [JSON.stringify([message.sessionID, message.id]), index]),
  );
  for (const message of messages) {
    let items = sessions.get(message.sessionID);
    if (!items) sessions.set(message.sessionID, items = []);
    items.push(message);
  }
  return [...sessions.values()].flatMap((items) => {
    const owner = createTranscriptProjection();
    owner.replace(items);
    owner.busy(busy);
    return owner.state.replyIDs.map((id) => owner.state.repliesByID[id]);
  }).sort((a, b) =>
    positions.get(JSON.stringify([a.message.sessionID, a.message.id]))! -
    positions.get(JSON.stringify([b.message.sessionID, b.message.id]))!
  );
}
