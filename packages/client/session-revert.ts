// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage, type RevertInfo } from "@otk/protocol";
import type { SessionActions } from "./session-actions.ts";
import type { ClientSession, Selection } from "./session.ts";
import type { ContentState } from "./reduce.ts";
import { createState, type StateFactory } from "./state.ts";

export interface RevertStrip {
  count: number;
  preview: string;
  prompts: NonNullable<RevertInfo["prompts"]>;
  more: number;
  files: RevertInfo["files"];
}
export interface SessionRevertState {
  pending?: "revert" | "restore";
  error?: string;
}
export interface SessionRevert {
  readonly state: SessionRevertState;
  matches(target: Selection): boolean;
  revertTo(messageID: string): Promise<void>;
  restore(): Promise<void>;
  strip(content: ContentState): RevertStrip | undefined;
  dispose(): void;
}
/** One selected-session operation lifetime; server content is never optimistic. */
export function createSessionRevert(options: {
  session: Pick<ClientSession, "state" | "subscribe">;
  actions: Pick<SessionActions, "revert" | "restore">;
  factory?: StateFactory;
}): SessionRevert {
  const store = (options.factory ?? createState)<SessionRevertState>({});
  const identity = () => {
    const t = options.session.state.selection;
    return t ? `${t.sidecarId}/${t.sessionID}` : "";
  };
  let key = identity(), generation = 0, pending = false, alive = true;
  const reset = () => {
    generation++;
    pending = false;
    store.update((state) => {
      state.pending = undefined;
      state.error = undefined;
    });
  };
  const observe = () => {
    const next = identity();
    if (next !== key) {
      key = next;
      reset();
    }
  };
  const release = options.session.subscribe(observe);
  const run = async (kind: "revert" | "restore", messageID?: string) => {
    observe();
    const target = options.session.state.selection;
    if (!alive || !target || pending) return;
    const captured = { ...target }, current = generation;
    pending = true;
    store.update((state) => {
      state.pending = kind;
      state.error = undefined;
    });
    try {
      if (kind === "revert") await options.actions.revert(captured, messageID!);
      else await options.actions.restore(captured);
    } catch (error) {
      observe();
      if (alive && generation === current) {
        store.update((state) => {
          state.error = errorMessage(error);
        });
      }
    } finally {
      observe();
      if (alive && generation === current) {
        pending = false;
        store.update((state) => {
          state.pending = undefined;
        });
      }
    }
  };
  return {
    state: store.state,
    matches: (target) => {
      const selected = options.session.state.selection;
      return !!selected && selected.sidecarId === target.sidecarId &&
        selected.sessionID === target.sessionID;
    },
    revertTo: (id) => run("revert", id),
    restore: () => run("restore"),
    strip(content) {
      const revert = content.revert;
      if (!revert) return;
      const prompts = revert.prompts ?? [];
      return {
        count: revert.messageCount,
        preview: prompts[0]?.preview ?? "",
        prompts,
        more: Math.max(0, revert.messageCount - prompts.length),
        files: revert.files,
      };
    },
    dispose() {
      alive = false;
      release();
      reset();
    },
  };
}
