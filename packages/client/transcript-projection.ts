// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp, Message, Part, ReplyBoundary } from "@otk/protocol";
import { reduceMessage } from "./reduce.ts";

export interface TranscriptReply {
  key: string;
  firstID: string;
  lastID: string;
  messageIDs: string[];
  segments: { messageID: string; parts: Part[] }[];
  message: Message;
  pending?: boolean;
  revision: number;
}
export interface TranscriptProjectionState {
  messageIDs: string[];
  messagesByID: Record<string, Message>;
  replyIDs: string[];
  repliesByID: Record<string, TranscriptReply>;
  queuedIDs: Set<string>;
}
export const replyKey = (message: Message): string =>
  message.role === "assistant"
    ? `reply:${message.replyTo ?? message.id}`
    : message.id;
const compare = (a: Message, b: Message) =>
  a.time.created - b.time.created || a.id.localeCompare(b.id);
const dictionary = <T>(): Record<string, T> => Object.create(null);
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
  const state: TranscriptProjectionState = {
    messageIDs: [],
    messagesByID: dictionary<Message>(),
    replyIDs: [],
    repliesByID: dictionary<TranscriptReply>(),
    queuedIDs: new Set(),
  };
  const parts = new Map<string, Map<string, number>>();
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
    const oldUnfinished = previous?.role === "assistant" &&
      previous.time.completed === undefined;
    const newUnfinished = next?.role === "assistant" &&
      next.time.completed === undefined;
    if (
      previous?.role === next?.role &&
      previous?.time.created === next?.time.created && oldTurn === newTurn &&
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
    if (previous?.role === "user") {
      userClocks.delete(previous.id);
      userOrder = userOrder.filter((id) => id !== previous.id);
      touched.add(previous.id);
    }
    if (next?.role === "user") {
      userClocks.set(next.id, next.time.created);
      userOrder = ordered(userOrder, next.id, userClocks);
      touched.add(next.id);
    }
    if (oldUnfinished) {
      unfinishedClocks.delete(previous!.id);
      unfinishedOrder = unfinishedOrder.filter((id) => id !== previous!.id);
    }
    if (newUnfinished) {
      unfinishedClocks.set(next!.id, next!.time.created);
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
  const group = (key: string, ids: string[], changed?: Message) => {
    const previous = state.repliesByID[key];
    if (!ids.length) {
      const turn = previous?.message.role === "assistant"
        ? previous.message.replyTo
        : undefined;
      if (turn !== undefined && pendingTurns.delete(turn)) touched.add(turn);
      lastHeaders.delete(key);
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
    const message: Message = {
      ...last,
      id: first.id,
      time: { ...last.time, created: first.time.created },
      get parts() {
        return partsForReply();
      },
    };
    if (message.role === "assistant") {
      message.interrupted = !!(previous?.message.role === "assistant" &&
        previous.message.interrupted) || message.interrupted;
      message.error ??= previous?.message.role === "assistant"
        ? previous.message.error
        : undefined;
      if (message.replyTo !== undefined) {
        const pending = message.time.completed === undefined;
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
    if (!previous || previous.messageIDs[0] !== ids[0]) {
      const keys = state.replyIDs.filter((id) => id !== key);
      let low = 0, high = keys.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (compare(state.repliesByID[keys[mid]].message, message) < 0) {
          low = mid + 1;
        } else high = mid;
      }
      keys.splice(low, 0, key);
      state.replyIDs = keys;
    }
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
  };
  const put = (message: Message, preservePartIndex = false) => {
    const previous = read(message.id),
      oldKey = previous && replyKey(previous),
      key = replyKey(message);
    if (previous === message) return;
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
    if (segment?.parts !== message.parts) {
      segmentByID.set(message.id, {
        messageID: message.id,
        parts: message.parts,
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
    group(
      key,
      location?.key === key && !reordered
        ? ids
        : insert(ids.filter((id) => id !== message.id), message.id, read),
      message,
    );
    detached = undefined;
  };
  const remove = (id: string) => {
    const previous = read(id);
    if (!previous) return;
    header(previous, undefined);
    const key = replyKey(previous);
    delete state.messagesByID[id];
    parts.delete(id);
    clearHelper(id);
    segmentByID.delete(id);
    locations.delete(id);
    state.messageIDs = state.messageIDs.filter((key) => key !== id);
    group(key, state.repliesByID[key].messageIDs.filter((key) => key !== id));
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
    clear() {
      state.messageIDs = [];
      state.messagesByID = dictionary<Message>();
      state.replyIDs = [];
      state.repliesByID = dictionary<TranscriptReply>();
      state.queuedIDs = new Set();
      parts.clear();
      helperLinks.clear();
      helperChildren.clear();
      boundaries.clear();
      lastHeaders.clear();
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
      owner.clear();
      for (const message of messages) put(message);
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
        if (op.op === "message.upsert") queues();
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
