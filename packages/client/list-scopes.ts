// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectSelection } from "./project-navigation.ts";
import type { WindowAnchor } from "./window.ts";
import { createState, type StateFactory } from "./state.ts";
import type { SessionListRow } from "./session-tree.ts";
export interface ListInteraction {
  query: string;
  anchor?: WindowAnchor;
  scrollTop: number;
  collapsedGroups?: string[];
}
/** Group disclosure belongs to the retained list interaction, not mounted rows. */
export function createSessionGroupDisclosure(
  interaction?: ListInteraction,
  factory: StateFactory = createState,
): {
  open(group: string): boolean;
  set(group: string, value: boolean): void;
  rows(rows: readonly SessionListRow[]): SessionListRow[];
} {
  const store = factory({ collapsed: interaction?.collapsedGroups ?? [] });
  const open = (group: string) => !store.state.collapsed.includes(group);
  return {
    open,
    set(group: string, value: boolean) {
      store.update((draft) => {
        draft.collapsed = value
          ? draft.collapsed.filter((id) => id !== group)
          : [...new Set([...draft.collapsed, group])];
        if (interaction) interaction.collapsedGroups = [...draft.collapsed];
      });
    },
    rows: (rows: readonly SessionListRow[]) =>
      rows.filter((row) => row.kind === "heading" || open(row.group)),
  };
}
export function createListScopes(): {
  get(project: ProjectSelection, task?: string): ListInteraction;
  remove(server: string): void;
  clear(): void;
} {
  const scopes = new Map<string, Map<string, ListInteraction>>();
  return {
    get(project, task) {
      let server = scopes.get(project.sidecarId);
      if (!server) scopes.set(project.sidecarId, server = new Map());
      const key = JSON.stringify([project.directory, task]);
      let state = server.get(key);
      if (!state) server.set(key, state = { query: "", scrollTop: 0 });
      return state;
    },
    remove: (server) => {
      scopes.delete(server);
    },
    clear: () => scopes.clear(),
  };
}
