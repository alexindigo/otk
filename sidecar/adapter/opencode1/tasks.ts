// SPDX-License-Identifier: LGPL-3.0-only
import type { Part, TaskCall } from "../../../protocol/content.ts";
import { mapTool } from "./map-tools.ts";
import type { Info, RawPart } from "./types.ts";
interface Link {
  parent: string;
  message: string;
  part: string;
}
interface Summary {
  tools: Set<string>;
  current?: { time: number; text: string };
  start?: number;
  end?: number;
}
/** Open-parent metadata only: IDs/counts/titles, never child messages or output. */
export class TaskProgress {
  #links = new Map<string, Map<string, Link>>();
  #summaries = new Map<string, Summary>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #parents = new Map<string, object>();
  constructor(
    readonly read: (
      id: string,
      message?: string,
    ) => Promise<{ info: Info; parts: RawPart[] }[]>,
    readonly subscribed: (id: string) => boolean,
    readonly emit: (parent: string, message: string, part: Part) => void,
    readonly recover: () => void,
  ) {}
  #apply(summary: Summary, info?: Info, part?: RawPart) {
    if (info?.role === "user") {
      summary.start = Math.min(summary.start ?? Infinity, info.time.created);
    }
    if (info?.role === "assistant" && info.time.completed !== undefined) {
      summary.end = Math.max(summary.end ?? 0, info.time.completed);
    }
    if (part?.type === "tool") {
      summary.tools.add(part.id);
      const time = part.state?.time?.start ?? 0;
      if (
        part.state?.status !== "pending" && time >= (summary.current?.time ?? 0)
      ) {
        summary.current = {
          time,
          text: `${part.tool} ${part.state?.title || ""}`.trim(),
        };
      }
    }
  }
  #decorate(call: TaskCall, summary: Summary): TaskCall {
    return {
      ...call,
      toolCount: summary.tools.size,
      currentTool: summary.current?.text,
      duration: summary.start !== undefined && summary.end !== undefined
        ? Math.max(0, summary.end - summary.start)
        : call.duration,
    };
  }
  async shape(raw: RawPart): Promise<TaskCall> {
    const call = mapTool(raw) as TaskCall, child = call.childSessionID;
    if (!child) return call;
    let owner = this.#parents.get(raw.sessionID);
    if (!owner && this.subscribed(raw.sessionID)) {
      this.#parents.set(raw.sessionID, owner = {});
    }
    let summary = this.#summaries.get(child);
    if (!summary) {
      summary = { tools: new Set() };
      for (const message of await this.read(child)) {
        this.#apply(summary, message.info);
        for (const part of message.parts) this.#apply(summary, undefined, part);
      }
      if (
        owner && this.#parents.get(raw.sessionID) === owner &&
        this.subscribed(raw.sessionID)
      ) this.#summaries.set(child, summary);
    }
    if (
      owner && this.#parents.get(raw.sessionID) === owner &&
      this.subscribed(raw.sessionID)
    ) {
      let links = this.#links.get(child);
      if (!links) this.#links.set(child, links = new Map());
      links.set(raw.id, {
        parent: raw.sessionID,
        message: raw.messageID,
        part: raw.id,
      });
    }
    return this.#decorate(call, summary);
  }
  observe(id: string, info?: Info, part?: RawPart): void {
    const summary = this.#summaries.get(id);
    if (!summary) return;
    this.#apply(summary, info, part);
    if (this.#timers.has(id)) return;
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id);
        void this.#refresh(id, summary).catch((error) => {
          console.warn("task summary:", error);
          this.recover();
        });
      }, 50),
    );
  }
  async #refresh(id: string, summary: Summary) {
    const links = this.#links.get(id);
    if (!links) return;
    for (const link of links.values()) {
      if (!this.subscribed(link.parent)) continue;
      const messages = await this.read(link.parent, link.message);
      if (this.#links.get(id) !== links || !this.subscribed(link.parent)) {
        return;
      }
      const raw = messages[0]?.parts.find((part) => part.id === link.part);
      if (raw?.tool === "task") {
        this.emit(link.parent, link.message, {
          kind: "tool",
          id: raw.id,
          call: this.#decorate(mapTool(raw) as TaskCall, summary),
        });
      }
    }
  }
  release(parent?: string): void {
    if (parent === undefined) this.#parents.clear();
    else this.#parents.delete(parent);
    for (const [id, links] of this.#links) {
      for (const [key, link] of links) {
        if (parent === undefined || link.parent === parent) links.delete(key);
      }
      if (links.size) continue;
      clearTimeout(this.#timers.get(id));
      this.#timers.delete(id);
      this.#links.delete(id);
      this.#summaries.delete(id);
    }
  }
}
