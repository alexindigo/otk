// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectSeed } from "@otk/harness";
import type { ProjectTopology } from "@otk/protocol";
import type { CheckoutAuthority, CheckoutRecord } from "@otk/store";

const key = (r: Pick<CheckoutRecord, "source" | "repoID" | "scope">) =>
  JSON.stringify([r.source, r.repoID, r.scope]);
const within = (directory: string, root: string) =>
  directory === root ||
  directory.startsWith(root.endsWith("/") ? root : root + "/");

export interface IdentityChange {
  repos: ReadonlySet<string>;
  directories: ReadonlySet<string>;
}
const unchanged = (): IdentityChange => ({
  repos: new Set(),
  directories: new Set(),
});
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((v) => b.has(v));
/** Sole owner of native repository membership and historical checkout boundaries. */
/** Only a worktree can be removed. A project's own folder (its canonical
 * root, or a folder without Git) missing from a worktree inventory is not
 * evidence that it was removed. */
function removable(
  leafDirectory: string,
  canonicalRoot: string,
): "removed" | "unknown" {
  return canonicalRoot && leafDirectory !== canonicalRoot
    ? "removed"
    : "unknown";
}
export class ProjectIdentity {
  #revision = 0;
  get revision(): number {
    return this.#revision;
  }
  #records = new Map<string, CheckoutRecord>();
  #scopes = new Map<string, CheckoutRecord[]>();
  #leaves = new Map<string, CheckoutRecord[]>();
  #sources = new Set<string>();
  #current = new Map<string, ReadonlySet<string>>();
  #authoritative = false;
  constructor(
    readonly history?: {
      list(): CheckoutRecord[];
      authority?(): CheckoutAuthority | undefined;
      save(
        rows: readonly CheckoutRecord[],
        authority?: CheckoutAuthority,
      ): void;
    },
  ) {
    for (const r of history?.list() ?? []) {
      this.#records.set(key(r), { ...r, availability: "unknown" });
      this.#sources.add(r.source);
    }
    const authority = history?.authority?.();
    if (authority) {
      this.#sources = new Set(authority.sources);
      this.#current = new Map(
        authority.scopes.map((
          { source, scope, owners },
        ) => [JSON.stringify([source, scope]), new Set(owners)]),
      );
      this.#authoritative = true;
    }
    this.#index();
  }
  records(): CheckoutRecord[] {
    return structuredClone([...this.#records.values()]);
  }
  remember(
    directory: string,
    repoID: string,
    recordedRoot?: string,
  ): IdentityChange {
    const rows = [...this.#records.values()].filter((r) =>
      this.#sources.has(r.source) && r.repoID === repoID
    );
    if (!rows.length || new Set(rows.map((r) => r.source)).size !== 1) {
      return unchanged();
    }
    const previous = rows.find((r) => r.scope === directory);
    if (
      previous &&
      (recordedRoot === undefined || previous.leafDirectory === recordedRoot)
    ) return unchanged();
    const leafDirectory = recordedRoot ?? this.leaf(directory, repoID);
    const known = rows.find((r) => r.leafDirectory === leafDirectory);
    const record: CheckoutRecord = {
      ...rows[0],
      scope: directory,
      leafDirectory,
      proven: recordedRoot !== undefined || known?.proven === true,
      kind: known?.kind ?? "unknown",
      availability: known?.availability ?? "unknown",
    };
    const records = new Map(this.#records);
    records.set(key(record), record);
    return this.#accept(
      records,
      this.#sources,
      this.#current,
      this.#authoritative,
    );
  }
  learn(seeds: readonly ProjectSeed[]): IdentityChange {
    const records = new Map(this.#records);
    const current = new Map(this.#current);
    const reported = new Map<string, Set<string>>();
    for (const seed of seeds) {
      for (const fact of seed.identities ?? []) {
        const scope = JSON.stringify([fact.source, seed.directory]);
        const owners = reported.get(scope) ?? new Set<string>();
        owners.add(fact.repoID);
        reported.set(scope, owners);
      }
    }
    // A positive grouped native population can prove an ownership revision.
    // Mere inventory disappearance cannot: empty/unavailable facts retain history.
    for (const [scope, owners] of reported) current.set(scope, owners);
    const sources = new Set(
      seeds.flatMap((seed) =>
        seed.identities?.map((fact) => fact.source) ?? []
      ),
    );
    const selected = sources.size ? sources : new Set(this.#sources);
    const put = (r: CheckoutRecord) => {
      const k = key(r);
      if (JSON.stringify(records.get(k)) === JSON.stringify(r)) return;
      records.set(k, r);
    };
    for (const seed of seeds) {
      const facts = seed.identities ??
        (seed.topology &&
            ![...records.values()].some((r) =>
              r.scope === seed.directory && r.source !== "injected"
            )
          ? [{
            source: "injected",
            repoID: seed.topology.repoID,
            canonicalRoot: seed.topology.canonicalRoot,
            recordedRoot: seed.topology.leafDirectory,
          }]
          : []);
      for (const fact of facts) {
        selected.add(fact.source);
        const same = [...records.values()].filter((r) =>
          r.source === fact.source && r.repoID === fact.repoID
        );
        const canonicalRoot = fact.canonicalRoot ?? same[0]?.canonicalRoot ??
          "";
        // Canonical relocation and pruning update facts, never discard affiliation.
        for (const r of same) {
          put({
            ...r,
            canonicalRoot,
            availability: fact.inventory === undefined
              ? "unknown"
              : r.proven
              ? fact.inventory.some((i) => i.directory === r.leafDirectory)
                ? "present"
                : removable(r.leafDirectory, canonicalRoot)
              : "unknown",
          });
        }
        const previous = records.get(
          key({
            source: fact.source,
            repoID: fact.repoID,
            scope: seed.directory,
          }),
        );
        const roots = [
          ...fact.inventory?.map((r) => r.directory) ?? [],
          ...fact.historicalRoots ?? [],
          ...same.filter((r) => r.proven).map((r) => r.leafDirectory),
          ...(canonicalRoot ? [canonicalRoot] : []),
        ];
        const root = fact.recordedRoot ??
          (previous?.proven ? previous.leafDirectory : undefined) ??
          roots.filter((r) =>
            fact.recordedRoot === null
              ? r === seed.directory
              : within(seed.directory, r)
          ).sort((a, b) => b.length - a.length)[0];
        const leafDirectory = root ?? seed.directory;
        const registered = fact.inventory?.find((r) =>
          r.directory === leafDirectory
        );
        const proven = root !== undefined;
        put({
          source: fact.source,
          repoID: fact.repoID,
          scope: seed.directory,
          canonicalRoot,
          leafDirectory,
          proven,
          kind: registered?.kind ??
            (leafDirectory === canonicalRoot
              ? "checkout"
              : previous?.kind ?? "unknown"),
          availability: fact.inventory === undefined || !proven
            ? "unknown"
            : registered
            ? "present"
            : removable(leafDirectory, canonicalRoot),
        });
      }
      // Legacy null means loss of inventory, not loss of a durable native edge.
      if (seed.topology === null && !seed.identities) {
        for (const r of records.values()) {
          if (r.scope === seed.directory) {
            put({
              ...r,
              availability: removable(r.leafDirectory, r.canonicalRoot),
            });
          }
        }
      }
    }
    return this.#accept(
      records,
      selected,
      current,
      this.#authoritative || reported.size > 0,
    );
  }
  #accept(
    records: Map<string, CheckoutRecord>,
    sources: ReadonlySet<string>,
    current: Map<string, ReadonlySet<string>>,
    authoritative: boolean,
  ): IdentityChange {
    const repos = new Set<string>(), directories = new Set<string>();
    const changed = [...records].filter(([k, r]) =>
      JSON.stringify(this.#records.get(k)) !== JSON.stringify(r)
    );
    const sourceChanged = !sameSet(this.#sources, sources);
    const scopeChanges = [...current].filter(([scope, owners]) =>
      !this.#current.has(scope) || !sameSet(this.#current.get(scope)!, owners)
    );
    const affectedScopes = new Set(scopeChanges.map(([scope]) => scope));
    const affectedRecords = new Set(changed.map(([k]) => k));
    for (const r of [...this.#records.values(), ...records.values()]) {
      if (
        !sourceChanged && !affectedRecords.has(key(r)) &&
        !affectedScopes.has(JSON.stringify([r.source, r.scope]))
      ) continue;
      repos.add(r.repoID);
      for (const directory of [r.scope, r.leafDirectory, r.canonicalRoot]) {
        if (directory) directories.add(directory);
      }
    }
    if (
      !changed.length && !scopeChanges.length && !sourceChanged &&
      authoritative === this.#authoritative
    ) return unchanged();
    this.history?.save(
      changed.map(([, row]) => row),
      authoritative
        ? {
          sources: [...sources],
          scopes: scopeChanges.map(([k, owners]) => {
            const [source, scope] = JSON.parse(k);
            return { source, scope, owners: [...owners] };
          }),
        }
        : undefined,
    );
    this.#records = records;
    this.#sources = new Set(sources);
    this.#current = current;
    this.#authoritative = authoritative;
    this.#revision++;
    this.#index();
    return { repos, directories };
  }
  #index(): void {
    this.#scopes.clear();
    this.#leaves.clear();
    for (const r of this.#records.values()) {
      if (!this.#sources.has(r.source)) continue;
      const owners = this.#current.get(JSON.stringify([r.source, r.scope]));
      if (owners && !owners.has(r.repoID)) continue;
      for (
        const [map, id] of [[this.#scopes, r.scope], [
          this.#leaves,
          r.leafDirectory,
        ]] as const
      ) {
        const rows = map.get(id) ?? [];
        rows.push(r);
        map.set(id, rows);
      }
    }
  }
  leaf(directory: string, repoID?: string): string {
    const rows = (this.#scopes.get(directory) ?? []).filter((r) =>
      repoID === undefined || r.repoID === repoID
    );
    const roots = new Set(rows.map((r) => r.leafDirectory));
    if (roots.size === 1) return [...roots][0];
    if (roots.size > 1 || repoID === undefined) return directory;
    // A live metadata scope can arrive before its grouped seed. Only this owner
    // may use native-qualified learned boundaries; clients use exact projection.
    return [...this.#records.values()].filter((r) =>
      this.#sources.has(r.source) && r.repoID === repoID && r.proven &&
      within(directory, r.leafDirectory)
    ).sort((a, b) => b.leafDirectory.length - a.leafDirectory.length)[0]
      ?.leafDirectory ?? directory;
  }
  topology(directory: string): ProjectTopology | undefined {
    const rows = this.#leaves.get(directory) ?? [];
    const owners = new Set(
      rows.map((r) => JSON.stringify([r.source, r.repoID, r.canonicalRoot])),
    );
    if (owners.size !== 1) return;
    const r = rows[0];
    if (!r.canonicalRoot) return;
    return {
      repoID: r.repoID,
      canonicalRoot: r.canonicalRoot,
      leafDirectory: directory,
      ...(directory === r.canonicalRoot
        ? {}
        : { parentDirectory: r.canonicalRoot }),
    };
  }
  availability(directory: string): CheckoutRecord["availability"] | undefined {
    const rows = this.#leaves.get(directory);
    return rows?.some((r) => r.availability === "present")
      ? "present"
      : rows?.every((r) => r.availability === "removed")
      ? "removed"
      : rows?.length
      ? "unknown"
      : undefined;
  }
  memberships(directory: string) {
    return (this.#leaves.get(directory) ?? []).map((r) => ({
      source: r.source,
      repoID: r.repoID,
      directory: r.scope,
      leafDirectory: r.leafDirectory,
      availability: r.availability,
      kind: r.kind,
    }));
  }
  topologies(): ProjectTopology[] {
    return [...this.#leaves.keys()].flatMap((directory) =>
      this.topology(directory) ?? []
    );
  }
}
