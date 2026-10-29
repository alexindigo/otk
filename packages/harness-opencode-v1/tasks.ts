// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp, HelperSummary, TaskCall } from "@otk/protocol";
import { mapTool } from "./map-tools.ts";
import type { RawPart } from "./types.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";

interface Link {
  parent: string;
  message: string;
  part: string;
  child: string;
  generation: number;
  revision: number;
}
/** Synchronous links only. No native reader, source, timers or async work. */
export class TaskProgress {
  #links = new Map<string, Link>();
  #generation = 0;
  constructor(
    readonly options: {
      peek(id: string): HelperSummary | undefined;
      request?(id: string): void;
      subscribed(id: string): boolean;
      emit(parent: string, event: ContentOp): void;
    },
  ) {}
  shape(raw: RawPart): TaskCall {
    const call = mapTool(raw) as TaskCall, child = call.childSessionID;
    const parent = ids.encode(raw.sessionID);
    this.remove(parent, raw.messageID, raw.id);
    if (!child) return call;
    const progress = this.options.peek(child) ?? {
      state: this.options.request ? "digesting" : "unavailable",
      revision: 0,
      toolCount: null,
    } as HelperSummary;
    if (this.options.subscribed(parent)) {
      this.#links.set(JSON.stringify([parent, raw.messageID, raw.id]), {
        parent,
        message: raw.messageID,
        part: raw.id,
        child,
        generation: ++this.#generation,
        revision: progress.revision,
      });
    }
    if (progress.state === "digesting") this.options.request?.(child);
    return { ...call, progress };
  }
  update(child: string, summary: HelperSummary): void {
    for (const link of this.#links.values()) {
      if (
        link.child !== child || summary.revision <= link.revision ||
        !this.options.subscribed(link.parent)
      ) continue;
      link.revision = summary.revision;
      this.options.emit(link.parent, {
        op: "task.progress",
        messageID: link.message,
        partID: link.part,
        childSessionID: child,
        summary,
      });
    }
  }
  remove(parent: string, message: string, part?: string): void {
    for (const [key, link] of this.#links) {
      if (
        link.parent === parent && link.message === message &&
        (part === undefined || link.part === part)
      ) this.#links.delete(key);
    }
  }
  cutoff(parent: string, cutoff: string): void {
    for (const [key, link] of this.#links) {
      if (link.parent === parent && link.message >= cutoff) {
        this.#links.delete(key);
      }
    }
  }
  release(parent?: string): void {
    for (const [key, link] of this.#links) {
      if (parent === undefined || link.parent === parent) {
        this.#links.delete(key);
      }
    }
  }
  dispose(id: string): void {
    this.release(id);
    for (const [key, link] of this.#links) {
      if (link.child === id) this.#links.delete(key);
    }
  }
  stop(): Promise<void> {
    this.release();
    return Promise.resolve();
  }
}
