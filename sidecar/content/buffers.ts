// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp, Part } from "../../protocol/content.ts";
import { markdown } from "./markdown.ts";
import { StreamingMarkdown } from "./stream.ts";

type StreamingPart = Extract<Part, { kind: "text" | "reasoning" }>;
type Emit = (sessionID: string, event: ContentOp) => void;
interface ActivePart {
  stream: StreamingMarkdown;
  shell: StreamingPart;
  sessionID: string;
  messageID: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns only authoritative, currently streaming parts with live subscribers. */
export class StreamBuffers {
  #parts = new Map<string, ActivePart>();
  #subscriptions = new Map<string, number>();

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
      this.removeSession(sessionID);
    }
  }
  upsert(
    sessionID: string,
    messageID: string,
    part: StreamingPart,
    text: string,
  ): void {
    if (!this.subscribed(sessionID)) return;
    const active = this.#parts.get(part.id);
    const shell = { ...part, blocks: [] };
    if (active) {
      active.stream.replace(text);
      active.shell = shell;
    } else {
      this.#parts.set(part.id, {
        stream: new StreamingMarkdown(text),
        shell,
        sessionID,
        messageID,
      });
    }
  }
  append(partID: string, delta: string, emit: Emit): boolean {
    const part = this.#parts.get(partID);
    if (!part) return false;
    part.stream.append(delta);
    if (part.timer === undefined) {
      part.timer = setTimeout(() => {
        part.timer = undefined;
        emit(part.sessionID, {
          op: "part.blocks",
          messageID: part.messageID,
          partID,
          ...part.stream.flush(),
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
      emit(active.sessionID, event);
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
