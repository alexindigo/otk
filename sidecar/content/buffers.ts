// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp, Message, Part } from "../../protocol/content.ts";
import { markdown } from "./markdown.ts";
import { StreamingMarkdown } from "./stream.ts";

type StreamingPart = Extract<Part, { kind: "text" | "reasoning" }>;
type Emit = (sessionID: string, event: ContentOp) => void;
interface ActivePart {
  stream: StreamingMarkdown;
  shell: StreamingPart;
  sessionID: string;
  messageID: string;
  version: number;
  lastChunk: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns authoritative unfinished text independently of its current viewers. */
export class StreamBuffers {
  #parts = new Map<string, ActivePart>();
  #subscriptions = new Map<string, number>();
  #version = 0;

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
      active.lastChunk = Date.now();
    } else {
      this.#parts.set(part.id, {
        stream: new StreamingMarkdown(text),
        shell,
        sessionID,
        messageID,
        version: ++this.#version,
        lastChunk: Date.now(),
      });
    }
  }
  append(partID: string, delta: string, emit: Emit): boolean {
    const part = this.#parts.get(partID);
    if (!part) return false;
    part.stream.append(delta);
    part.version = ++this.#version;
    part.lastChunk = Date.now();
    if (this.subscribed(part.sessionID) && part.timer === undefined) {
      part.timer = setTimeout(() => {
        part.timer = undefined;
        emit(part.sessionID, {
          op: "part.blocks",
          messageID: part.messageID,
          partID,
          ...part.stream.flush(),
          streamVersion: part.version,
        });
      }, 50);
    }
    return true;
  }
  complete(messageID: string, emit: Emit): void {
    for (const [id, active] of this.#parts) {
      if (active.messageID !== messageID) continue;
      const event: ContentOp = {
        op: "part.upsert",
        messageID,
        part: { ...active.shell, blocks: markdown(active.stream.text) },
      };
      this.remove(id);
      if (this.subscribed(active.sessionID)) emit(active.sessionID, event);
    }
  }
  snapshot(
    partID: string,
  ): { part: StreamingPart; lastChunk: number } | undefined {
    const active = this.#parts.get(partID);
    return active
      ? {
        part: {
          ...active.shell,
          blocks: markdown(active.stream.text),
          streamVersion: active.version,
        },
        lastChunk: active.lastChunk,
      }
      : undefined;
  }
  replay(sessionID: string, emit: Emit): void {
    for (const [id, active] of this.#parts) {
      if (active.sessionID === sessionID) {
        emit(sessionID, {
          op: "part.upsert",
          messageID: active.messageID,
          part: this.snapshot(id)!.part,
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
    return { ...message, parts };
  }
  removeMessage(messageID: string): void {
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
    for (const [id, part] of this.#parts) {
      if (part.sessionID === sessionID) this.remove(id);
    }
  }
  reset(): void {
    for (const id of this.#parts.keys()) this.remove(id);
  }
  stop(): void {
    this.reset();
    this.#subscriptions.clear();
  }
}
