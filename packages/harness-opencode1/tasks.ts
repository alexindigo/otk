// SPDX-License-Identifier: LGPL-3.0-only
import type { Part, TaskCall } from "@otk/protocol";
import { mapTool } from "./map-tools.ts";
import type { Info, RawPart } from "./types.ts";
import type { NativeMessage } from "./messages.ts";
interface Link {
  parent: string;
  message: string;
  part: string;
  owner: object;
}
interface Summary {
  tools: Set<string>;
  current?: { time: number; text: string; order?: [number, string, string] };
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
    ) => Promise<Iterable<NativeMessage> | AsyncIterable<NativeMessage>>,
    readonly subscribed: (id: string) => boolean,
    readonly emit: (parent: string, message: string, part: Part) => void,
    readonly recover: (parent: string, error: unknown) => void,
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
      // Native pages arrive newest first; ties still use transcript order,
      // not page traversal order. Live part events retain arrival ordering.
      const order: [number, string, string] | undefined = info
        ? [info.time.created, info.id, part.id]
        : undefined;
      const previous = summary.current;
      const later = !order || !previous?.order ||
        order[0] > previous.order[0] ||
        (order[0] === previous.order[0] &&
          (order[1] > previous.order[1] ||
            (order[1] === previous.order[1] && order[2] >= previous.order[2])));
      if (
        part.state?.status !== "pending" &&
        (time > (previous?.time ?? 0) ||
          (time === (previous?.time ?? 0) && later))
      ) {
        summary.current = {
          time,
          text: `${part.tool} ${part.state?.title || ""}`.trim(),
          order,
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
      for await (const message of await this.read(child)) {
        this.#apply(summary, message.info);
        for (const part of message.parts) {
          this.#apply(summary, message.info, part);
        }
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
        owner,
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
        void this.#refresh(id, summary);
      }, 50),
    );
  }
  async #refresh(id: string, summary: Summary) {
    const links = this.#links.get(id);
    if (!links) return;
    for (const link of links.values()) {
      const current = () =>
        this.#links.get(id) === links &&
        links.get(link.part) === link &&
        this.#parents.get(link.parent) === link.owner &&
        this.subscribed(link.parent);
      if (!current()) continue;
      try {
        let raw: RawPart | undefined;
        for await (
          const message of await this.read(link.parent, link.message)
        ) {
          raw = message.parts.find((part) => part.id === link.part);
          break;
        }
        if (!current()) continue;
        if (raw?.tool === "task") {
          this.emit(link.parent, link.message, {
            kind: "tool",
            id: raw.id,
            call: this.#decorate(mapTool(raw) as TaskCall, summary),
          });
        }
      } catch (error) {
        if (current()) this.recover(link.parent, error);
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
