// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessCore } from "@otk/harness";
import {
  type IndexMetadata,
  type ProjectStatus,
  type SessionMetadata,
  urgentStatus,
} from "@otk/protocol";
import type { SessionHierarchy } from "../index/session-hierarchy.ts";

/** Project defaults are independent of the browser's acquired index window. */
export class NavigationDefault {
  constructor(
    readonly source: {
      hierarchy: SessionHierarchy;
      scopes(directory: string, repository?: boolean): readonly string[];
      entries(directory: string): readonly IndexMetadata[];
      status(id: string): ProjectStatus;
    },
  ) {}
  async resolve(
    core: HarnessCore,
    input: { directory: string; preferred?: string; attention?: boolean },
    signal?: AbortSignal,
  ): Promise<string | null> {
    const { hierarchy } = this.source;
    const directory = hierarchy.project(input.directory);
    const checkout = hierarchy.repository(directory) !== directory;
    const exact = checkout || input.attention === true;
    const scopes = [...new Set(this.source.scopes(directory, input.attention))];
    const entries = () => scopes.flatMap((scope) => this.source.entries(scope));
    const belongs = (row: { id: string }) =>
      scopes.includes(hierarchy.node(row.id)?.projectDirectory ?? "");
    const current = <T extends { id: string }>(row: T) =>
      entries().find((entry) => entry.id === row.id) ?? row;
    const eligible = (row: { id: string; deleted?: unknown }) =>
      belongs(row) && !current(row).deleted;
    const recent = (
      a: Pick<SessionMetadata, "id" | "timeUpdated">,
      b: Pick<SessionMetadata, "id" | "timeUpdated">,
    ) => b.timeUpdated - a.timeUpdated || b.id.localeCompare(a.id);
    const attention = () =>
      entries().filter((row) =>
        !row.deleted && belongs(row) && this.source.status(row.id) !== "none"
      ).sort((a, b) => {
        const x = this.source.status(a.id), y = this.source.status(b.id);
        return x === y ? recent(a, b) : urgentStatus(x, y) === x ? -1 : 1;
      })[0]?.id;
    // Human-root resolution is only a project default. An explicit checkout or
    // attention target must retain its session identity and checkout.
    const proven = (id: string) => {
      signal?.throwIfAborted();
      const node = hierarchy.node(id);
      if (
        !node || !scopes.includes(node.projectDirectory) ||
        entries().find((entry) => entry.id === id)?.deleted
      ) return null;
      if (exact) return id;
      const root = node?.ancestry === "complete" ? node.rootID : undefined;
      return root && !entries().find((entry) => entry.id === root)?.deleted
        ? root
        : null;
    };
    const human = async (id: string) => {
      const root = proven(id);
      if (root) return root;
      await hierarchy.prepare(
        await core.identities([id], signal),
        (ids, signal) => core.identities(ids, signal),
        signal,
      );
      signal?.throwIfAborted();
      return proven(id);
    };
    signal?.throwIfAborted();
    // Remembered selection is an explicit destination, not a default candidate.
    // Attention, new helpers and recency must never replace it on project return.
    if (input.preferred && !input.attention) {
      const rows = await core.identities([input.preferred], signal);
      await hierarchy.prepare(
        rows,
        (ids, signal) => core.identities(ids, signal),
        signal,
      );
      signal?.throwIfAborted();
      if (rows.some((row) => row.id === input.preferred && eligible(row))) {
        return input.preferred;
      }
    }
    const urgent = attention();
    if (urgent) {
      const root = await human(urgent);
      if (root && proven(urgent) === root) return root;
    }
    const candidates: SessionMetadata[] = [];
    for (const scope of scopes) {
      const page = await core.listSessions({
        directory: scope,
        ...(checkout ? {} : { parentID: null }),
        limit: 1,
      }, signal);
      await hierarchy.prepare(
        page.items,
        (ids, signal) => core.identities(ids, signal),
        signal,
      );
      candidates.push(
        ...page.items.filter((row) =>
          (checkout || !current(row).parentID) && eligible(row)
        ),
      );
    }
    signal?.throwIfAborted();
    const late = attention();
    if (late) {
      const root = await human(late);
      if (root && proven(late) === root) return root;
    }
    return candidates.map(current).filter((row) =>
      (checkout || !row.parentID) && eligible(row) && proven(row.id) === row.id
    )
      .sort(recent)[0]?.id ??
      null;
  }
}
