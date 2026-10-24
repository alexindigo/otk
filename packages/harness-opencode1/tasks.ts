// SPDX-License-Identifier: LGPL-3.0-only
import type { Part, TaskCall } from "@otk/protocol";
import { mapTool } from "./map-tools.ts";
import type { Info, RawPart } from "./types.ts";
import type { NativeMessage } from "./messages.ts";
interface Link {
  parent: string;
  message: string;
  part: string;
  owner: Parent;
}
interface Parent {
  id: string;
  controller: AbortController;
}
interface Child {
  summary: Summary;
  parents: Set<Parent>;
  links: Map<string, Link>;
  controller: AbortController;
  scan?: Promise<void>;
  running?: Promise<void>;
  timer?: () => void;
  dirty: boolean;
}
interface Summary {
  tools: Set<string>;
  current?: { time: number; text: string; order?: [number, string, string] };
  start?: number;
  end?: number;
}
interface TaskClock {
  schedule(run: () => void, milliseconds: number): () => void;
}
/** Open-parent metadata only: IDs/counts/titles, never child messages or output. */
export class TaskProgress {
  #children = new Map<string, Child>();
  #parents = new Map<string, Parent>();
  #pending = new Set<Promise<void>>();
  constructor(
    readonly read: (
      id: string,
      message?: string,
      signal?: AbortSignal,
    ) => Promise<Iterable<NativeMessage> | AsyncIterable<NativeMessage>>,
    readonly subscribed: (id: string) => boolean,
    readonly emit: (parent: string, message: string, part: Part) => void,
    readonly recover: (parent: string, error: unknown) => void,
    readonly clock: TaskClock = {
      schedule: (run, milliseconds) => {
        const timer = setTimeout(run, milliseconds);
        return () => clearTimeout(timer);
      },
    },
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
    const retained = this.subscribed(raw.sessionID);
    let owner = this.#parents.get(raw.sessionID);
    if (!owner) {
      owner = { id: raw.sessionID, controller: new AbortController() };
      if (retained) this.#parents.set(raw.sessionID, owner);
    }
    let state = this.#children.get(child);
    if (!state) {
      state = {
        summary: { tools: new Set() },
        parents: new Set(),
        links: new Map(),
        controller: new AbortController(),
        dirty: false,
      };
      this.#children.set(child, state);
      const current = state;
      current.scan = this.#track((async () => {
        for await (
          const message of await this.read(
            child,
            undefined,
            current.controller.signal,
          )
        ) {
          if (current.controller.signal.aborted) return;
          this.#apply(current.summary, message.info);
          for (const part of message.parts) {
            this.#apply(current.summary, message.info, part);
          }
        }
      })());
    }
    state.parents.add(owner);
    try {
      await state.scan;
      if (owner.controller.signal.aborted || state.controller.signal.aborted) {
        return call;
      }
      if (
        retained && this.#parents.get(raw.sessionID) === owner &&
        this.subscribed(raw.sessionID)
      ) {
        state.links.set(raw.id, {
          parent: raw.sessionID,
          message: raw.messageID,
          part: raw.id,
          owner,
        });
      }
      return this.#decorate(call, state.summary);
    } catch (error) {
      if (
        !owner.controller.signal.aborted && !state.controller.signal.aborted
      ) {
        this.#retireChild(child, state);
        throw error;
      }
      return call;
    } finally {
      if (!retained) this.#releaseParent(owner);
    }
  }
  #track(work: Promise<void>): Promise<void> {
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }
  observe(id: string, info?: Info, part?: RawPart): void {
    const state = this.#children.get(id);
    if (!state) return;
    this.#apply(state.summary, info, part);
    state.dirty = true;
    this.#schedule(id, state);
  }
  #schedule(id: string, state: Child): void {
    if (state.timer !== undefined || state.running || !state.links.size) return;
    state.timer = this.clock.schedule(() => {
      state.timer = undefined;
      state.dirty = false;
      const work = this.#refresh(id, state).finally(() => {
        state.running = undefined;
        if (this.#children.get(id) === state && state.dirty) {
          this.#schedule(id, state);
        }
      });
      state.running = this.#track(work);
    }, 50);
  }
  async #refresh(id: string, state: Child) {
    const { links, summary } = state;
    for (const link of links.values()) {
      const current = () =>
        this.#children.get(id) === state &&
        links.get(link.part) === link &&
        this.#parents.get(link.parent) === link.owner &&
        this.subscribed(link.parent);
      if (!current()) continue;
      try {
        let raw: RawPart | undefined;
        for await (
          const message of await this.read(
            link.parent,
            link.message,
            link.owner.controller.signal,
          )
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
    for (const state of this.#children.values()) {
      for (const owner of state.parents) {
        if (parent === undefined || owner.id === parent) {
          this.#releaseParent(owner);
        }
      }
    }
  }
  #releaseParent(owner: Parent): void {
    owner.controller.abort();
    if (this.#parents.get(owner.id) === owner) this.#parents.delete(owner.id);
    for (const [id, state] of this.#children) {
      state.parents.delete(owner);
      for (const [key, link] of state.links) {
        if (link.owner === owner) state.links.delete(key);
      }
      if (state.parents.size) continue;
      this.#retireChild(id, state);
    }
  }
  #retireChild(id: string, state: Child): void {
    if (this.#children.get(id) !== state) return;
    state.timer?.();
    state.controller.abort();
    this.#children.delete(id);
    for (const parent of state.parents) {
      if (
        ![...this.#children.values()].some((child) =>
          child.parents.has(parent)
        ) && this.#parents.get(parent.id) === parent
      ) {
        this.#parents.delete(parent.id);
      }
    }
    state.parents.clear();
    state.links.clear();
  }
  async stop(): Promise<void> {
    this.release();
    await Promise.allSettled(this.#pending);
  }
  /** A deleted session can be both an open parent and another parent's child. */
  dispose(id: string): void {
    this.release(id);
    const child = this.#children.get(id);
    if (child) this.#retireChild(id, child);
  }
}
