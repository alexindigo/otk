// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp, Message, Part } from "@otk/protocol";
import { StreamingMarkdown } from "./stream.ts";

type StreamingPart = Extract<Part, { kind: "text" | "reasoning" }>;
type Emit = (sessionID: string, event: ContentOp) => void;
interface ActivePart {
  stream: StreamingMarkdown;
  shell: StreamingPart;
  sessionID: string;
  messageID: string;
  version: number;
  published: number;
  generation: number;
  lastChunk: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns authoritative unfinished text independently of its current viewers. */
export class StreamBuffers {
  #parts = new Map<string, ActivePart>();
  #subscriptions = new Map<string, number>();
  #version = 0;
  #generation = 0;
  #epochs = new Map<string, string>();
  /** Replacement-only HTTP authority shares the event owner's generation clock. */
  replacement(sessionID: string): import("@otk/protocol").StreamStamp {
    let epoch = this.#epochs.get(sessionID);
    if (!epoch) this.#epochs.set(sessionID, epoch = crypto.randomUUID());
    return {
      epoch,
      generation: ++this.#generation,
      version: ++this.#version,
      mode: "replace",
    };
  }
  epoch(sessionID: string, epoch: string): void {
    if (this.#epochs.get(sessionID) === epoch) return;
    this.#epochs.set(sessionID, epoch);
    for (const part of this.#parts.values()) {
      if (part.sessionID !== sessionID) continue;
      part.generation = ++this.#generation;
      part.published = 0;
    }
  }
  #stamp(active: ActivePart): import("@otk/protocol").StreamStamp {
    let epoch = this.#epochs.get(active.sessionID);
    if (!epoch) this.#epochs.set(active.sessionID, epoch = crypto.randomUUID());
    return {
      epoch,
      generation: active.generation,
      version: active.version,
      mode: "appendable",
    };
  }
  #replies = new Map<
    string,
    { sessionID: string; observed?: number; ends: Map<string, number> }
  >();

  beginReply(sessionID: string, messageID: string): void {
    if (!this.#replies.has(messageID)) {
      this.#replies.set(messageID, { sessionID, ends: new Map() });
    }
  }
  observeOutput(
    sessionID: string,
    messageID: string,
    now: number = Date.now(),
    end?: number,
    partID?: string,
  ): number | undefined {
    const reply = this.#replies.get(messageID);
    if (!reply || reply.sessionID !== sessionID) return;
    reply.observed = now;
    if (end !== undefined && partID !== undefined) reply.ends.set(partID, end);
    return now;
  }
  outputTime(messageID: string): number | undefined {
    return this.#replies.get(messageID)?.observed;
  }
  outputEnd(messageID: string): number | undefined {
    let end: number | undefined;
    for (const value of this.#replies.get(messageID)?.ends.values() || []) {
      end = Math.max(end || 0, value);
    }
    return end;
  }
  forgetPart(messageID: string, partID: string): void {
    this.remove(partID);
    this.#replies.get(messageID)?.ends.delete(partID);
  }

  get size(): number {
    return this.#parts.size;
  }
  subscribed(sessionID: string): boolean {
    return this.#subscriptions.has(sessionID);
  }
  subscriptions(sessionID: string, count: number): void {
    if (count > 0) this.#subscriptions.set(sessionID, count);
    else {
      this.#subscriptions.delete(sessionID);
      for (const part of this.#parts.values()) {
        if (part.sessionID !== sessionID) continue;
        clearTimeout(part.timer);
        part.timer = undefined;
      }
    }
  }
  upsert(
    sessionID: string,
    messageID: string,
    part: StreamingPart,
    text: string,
  ): void {
    const now = Date.now();
    this.beginReply(sessionID, messageID);
    this.observeOutput(sessionID, messageID, now);
    let active = this.#parts.get(part.id);
    if (
      active &&
      (active.sessionID !== sessionID || active.messageID !== messageID)
    ) {
      this.remove(part.id);
      active = undefined;
    }
    const shell = { ...part, blocks: [] };
    if (active) {
      active.stream.replace(text);
      active.shell = shell;
      active.version = ++this.#version;
      active.generation = ++this.#generation;
      active.published = active.version;
      active.lastChunk = now;
    } else {
      this.#parts.set(part.id, {
        stream: new StreamingMarkdown(text),
        shell,
        sessionID,
        messageID,
        version: ++this.#version,
        published: this.#version,
        generation: ++this.#generation,
        lastChunk: now,
      });
    }
  }
  append(partID: string, delta: string, emit: Emit): boolean {
    const part = this.#parts.get(partID);
    if (!part) return false;
    part.stream.append(delta);
    part.version = ++this.#version;
    part.lastChunk = Date.now();
    this.observeOutput(part.sessionID, part.messageID, part.lastChunk);
    if (this.subscribed(part.sessionID) && part.timer === undefined) {
      part.timer = setTimeout(() => {
        part.timer = undefined;
        part.lastChunk = Date.now();
        this.observeOutput(part.sessionID, part.messageID, part.lastChunk);
        const baseVersion = part.published;
        part.published = part.version;
        emit(part.sessionID, {
          op: "part.blocks",
          messageID: part.messageID,
          partID,
          ...part.stream.flush(),
          stream: this.#stamp(part),
          baseVersion,
          lastOutput: part.lastChunk,
        });
      }, 50);
    }
    return true;
  }
  finishPart(
    sessionID: string,
    messageID: string,
    part: StreamingPart,
    text: string,
  ): StreamingPart | undefined {
    const active = this.#parts.get(part.id);
    if (
      !active || active.sessionID !== sessionID ||
      active.messageID !== messageID
    ) return;
    active.stream.replace(text);
    const { stream: _stream, ...shell } = part;
    const finished = { ...shell, blocks: active.stream.finish().blocks };
    this.remove(part.id);
    return finished;
  }
  complete(messageID: string, emit: Emit): void {
    for (const active of this.#parts.values()) {
      if (active.messageID !== messageID) continue;
      if (!this.subscribed(active.sessionID)) {
        this.remove(active.shell.id);
        continue;
      }
      const event: ContentOp = {
        op: "part.upsert",
        messageID,
        part: this.finishPart(
          active.sessionID,
          messageID,
          active.shell,
          active.stream.text,
        )!,
        lastOutput: this.outputTime(messageID),
      };
      emit(active.sessionID, event);
    }
    this.#replies.delete(messageID);
  }
  snapshot(
    partID: string,
    sessionID?: string,
    messageID?: string,
  ): { part: StreamingPart; lastChunk: number } | undefined {
    const active = this.#parts.get(partID);
    if (
      active &&
      ((sessionID !== undefined && active.sessionID !== sessionID) ||
        (messageID !== undefined && active.messageID !== messageID))
    ) return;
    return active
      ? {
        part: {
          ...active.shell,
          blocks: active.stream.snapshot().blocks,
          stream: this.#stamp(active),
        },
        lastChunk: active.lastChunk,
      }
      : undefined;
  }
  replay(sessionID: string, emit: Emit): void {
    this.checkpoint(sessionID, emit);
  }
  /** One synchronous source/publication checkpoint shared by every viewer. */
  checkpoint(sessionID: string, emit: Emit): void {
    for (const [id, active] of this.#parts) {
      if (active.sessionID === sessionID) {
        clearTimeout(active.timer);
        active.timer = undefined;
        active.stream.flush();
        active.published = active.version;
        emit(sessionID, {
          op: "part.upsert",
          messageID: active.messageID,
          part: this.snapshot(id)!.part,
          lastOutput: this.outputTime(active.messageID),
        });
      }
    }
  }
  overlay(message: Message): Message {
    if (message.role !== "assistant" || message.time.completed !== undefined) {
      return message;
    }
    const parts = [...message.parts];
    for (const [id, active] of this.#parts) {
      if (
        active.sessionID !== message.sessionID ||
        active.messageID !== message.id
      ) continue;
      const index = parts.findIndex((part) => part.id === id);
      const part = this.snapshot(id)!.part;
      if (index < 0) parts.push(part);
      else parts[index] = part;
    }
    const reply = this.#replies.get(message.id);
    return {
      ...message,
      parts,
      time: {
        ...message.time,
        ...(reply?.sessionID === message.sessionID &&
            reply.observed !== undefined
          ? { lastOutput: reply.observed }
          : {}),
      },
    };
  }
  removeMessage(messageID: string): void {
    this.#replies.delete(messageID);
    for (const [id, active] of this.#parts) {
      if (active.messageID === messageID) this.remove(id);
    }
  }
  remove(partID: string): void {
    const part = this.#parts.get(partID);
    if (part?.timer !== undefined) clearTimeout(part.timer);
    this.#parts.delete(partID);
  }
  removeSession(sessionID: string): void {
    this.#epochs.delete(sessionID);
    for (const [id, reply] of this.#replies) {
      if (reply.sessionID === sessionID) this.#replies.delete(id);
    }
    for (const [id, part] of this.#parts) {
      if (part.sessionID === sessionID) this.remove(id);
    }
  }
  reset(): void {
    this.#epochs.clear();
    this.#replies.clear();
    for (const id of this.#parts.keys()) this.remove(id);
  }
  stop(): void {
    this.reset();
    this.#subscriptions.clear();
  }
}
