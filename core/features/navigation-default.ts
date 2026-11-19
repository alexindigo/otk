// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessCore } from "@otk/harness";
import {
  attentionStatus,
  type IndexMetadata,
  type ProjectStatus,
  type SessionMetadata,
} from "@otk/protocol";
import type { SessionHierarchy } from "../index/session-hierarchy.ts";

/** Project defaults are independent of the browser's acquired index window. */
export class NavigationDefault {
  constructor(
    readonly source: {
      hierarchy: SessionHierarchy;
      scopes(directory: string): readonly string[];
      entries(directory: string): readonly IndexMetadata[];
      status(id: string): ProjectStatus;
    },
  ) {}
  async resolve(
    core: HarnessCore,
    input: { directory: string; preferred?: string },
    signal?: AbortSignal,
  ): Promise<string | null> {
    const { hierarchy } = this.source;
    const directory = hierarchy.project(input.directory);
    const scopes = [...new Set(this.source.scopes(directory))];
    const entries = () => scopes.flatMap((scope) => this.source.entries(scope));
    const belongs = (row: { id: string }) =>
      hierarchy.node(row.id)?.projectDirectory === directory;
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
        return x === y ? recent(a, b) : attentionStatus(x, y) === x ? -1 : 1;
      })[0]?.id;
    // Defaults open a human (top-level) session: a helper that needs
    // attention or was last viewed resolves to the top-level session owning it.
    const human = async (id: string) => {
      await hierarchy.prepare(
        await core.identities([id], signal),
        (ids, signal) => core.identities(ids, signal),
        signal,
      );
      signal?.throwIfAborted();
      const chain = hierarchy.ancestors(id);
      return chain.length ? chain[chain.length - 1] : id;
    };
    signal?.throwIfAborted();
    const urgent = attention();
    if (urgent) return human(urgent);
    if (input.preferred) {
      const rows = await core.identities([input.preferred], signal);
      await hierarchy.prepare(
        rows,
        (ids, signal) => core.identities(ids, signal),
        signal,
      );
      signal?.throwIfAborted();
      const urgent = attention();
      if (urgent) return human(urgent);
      if (
        rows.some((row) => row.id === input.preferred && eligible(row))
      ) return human(input.preferred);
    }
    const candidates: SessionMetadata[] = [];
    for (const scope of scopes) {
      const page = await core.listSessions({
        directory: scope,
        parentID: null,
        limit: 1,
      }, signal);
      await hierarchy.prepare(
        page.items,
        (ids, signal) => core.identities(ids, signal),
        signal,
      );
      candidates.push(
        ...page.items.filter((row) => !current(row).parentID && eligible(row)),
      );
    }
    signal?.throwIfAborted();
    const late = attention();
    if (late) return human(late);
    return candidates.map(current).filter((row) =>
      !row.parentID && eligible(row)
    )
      .sort(recent)[0]?.id ??
      null;
  }
}
