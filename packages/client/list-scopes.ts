// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectSelection } from "./project-navigation.ts";
import type { WindowAnchor } from "./window.ts";
export interface ListInteraction {
  query: string;
  anchor?: WindowAnchor;
  scrollTop: number;
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
