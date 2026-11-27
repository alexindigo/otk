// SPDX-License-Identifier: LGPL-3.0-only
import { failureValue } from "./failure-features.ts";
import {
  createInlineRename,
  type InlineRename,
  type InlineRenameState,
} from "./inline-rename.ts";
import type { Selection } from "./session.ts";
import type { StateFactory } from "./state.ts";

export type RenameOrigin = "tab" | "chip" | "row";
export interface RenameTarget extends Selection {
  title: string;
}
type ActiveRename = RenameTarget & { origin: RenameOrigin };
export type SessionRenameState = InlineRenameState<ActiveRename>;
export interface SessionRename
  extends Omit<InlineRename<ActiveRename>, "start" | "matches"> {
  start(target: RenameTarget, origin: RenameOrigin): void;
  matches(target: Selection, origin: RenameOrigin): boolean;
}

export function createSessionRename(o: {
  rename(target: Selection, title: string): Promise<unknown>;
  factory?: StateFactory;
  title?(target: Selection): string | undefined;
}): SessionRename {
  const owner = createInlineRename<ActiveRename>({
    same: (a, b) =>
      a.origin === b.origin && a.sidecarId === b.sidecarId &&
      a.sessionID === b.sessionID,
    rename: o.rename,
    current: o.title,
    factory: o.factory,
    failure: (error, target) =>
      failureValue(error, {
        action: "session.rename",
        target: { ...target, label: target.title },
      }),
  });
  return {
    ...owner,
    get editing() {
      return owner.editing;
    },
    start: (target, origin) => owner.start({ ...target, origin }),
    matches: (target, origin) =>
      owner.matches({ ...target, title: "", origin }),
  };
}
