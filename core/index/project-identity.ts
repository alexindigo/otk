// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectIdentityFact, ProjectSeed } from "@otk/harness";
import { type ProjectTopology, UNKNOWN_REPOSITORY } from "@otk/protocol";
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
interface IdentityRecord extends CheckoutRecord {
  /** Live coverage cannot survive restart as authority for absence. */
  inventory: "current" | "unknown";
}
function availability(
  record: Pick<CheckoutRecord, "leafDirectory" | "kind" | "proven">,
  inventory: ProjectIdentityFact["inventory"],
): CheckoutRecord["availability"] {
  if (inventory === undefined || !record.proven) return "unknown";
  if (inventory.some((row) => row.directory === record.leafDirectory)) {
    return "present";
  }
  return record.kind === "worktree" ? "removed" : "unknown";
}
/** Sole owner of native repository membership and historical checkout boundaries. */
export class ProjectIdentity {
  #revision = 0;
  get revision(): number {
    return this.#revision;
  }
  #records = new Map<string, IdentityRecord>();
  #scopes = new Map<string, IdentityRecord[]>();
  #leaves = new Map<string, IdentityRecord[]>();
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
      this.#records.set(key(r), {
        ...r,
        availability: "unknown",
        inventory: "unknown",
      });
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
    const { repository: _, ...base } = rows[0];
    const record: IdentityRecord = {
      ...base,
      scope: directory,
      leafDirectory,
      proven: recordedRoot !== undefined || known?.proven === true,
      kind: known?.kind ?? "unknown",
      availability: known?.availability ?? "unknown",
      inventory: known?.inventory ?? "unknown",
      ...(known?.repository ? { repository: known.repository } : {}),
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
    const put = (r: IdentityRecord) => {
      const k = key(r);
      const before = records.get(k);
      // Git evidence alone revises a recorded checkout's kind and presence.
      if (before?.repository !== undefined) {
        r = {
          ...r,
          repository: before.repository,
          kind: before.kind,
          availability: before.availability,
          inventory: before.inventory,
        };
      }
      if (JSON.stringify(before) === JSON.stringify(r)) return;
      records.set(k, r);
    };
    const evidence = new Map<
      string,
      NonNullable<ProjectIdentityFact["repository"]>
    >();
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
          const kind = fact.inventory?.find((i) =>
            i.directory === r.leafDirectory
          )?.kind ?? r.kind;
          put({
            ...r,
            canonicalRoot,
            kind,
            inventory: fact.inventory === undefined ? "unknown" : "current",
            availability: availability({ ...r, kind }, fact.inventory),
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
        const kind = registered?.kind ??
          same.find((r) => r.leafDirectory === leafDirectory)?.kind ??
          (leafDirectory === canonicalRoot ? "checkout" : "unknown");
        put({
          source: fact.source,
          repoID: fact.repoID,
          scope: seed.directory,
          canonicalRoot,
          leafDirectory,
          proven,
          kind,
          inventory: fact.inventory === undefined ? "unknown" : "current",
          availability: availability(
            { leafDirectory, kind, proven },
            fact.inventory,
          ),
        });
        if (fact.repository?.checkout === leafDirectory) {
          evidence.set(leafDirectory, fact.repository);
        }
      }
      // Legacy null means loss of inventory, not loss of a durable native edge.
      if (seed.topology === null && !seed.identities) {
        for (const r of records.values()) {
          if (r.scope === seed.directory) {
            put({
              ...r,
              availability: "unknown",
              inventory: "unknown",
            });
          }
        }
      }
    }
    for (const [checkout, fact] of evidence) {
      const repository = recordedRepository(records, checkout, fact);
      for (const [k, r] of records) {
        if (r.leafDirectory !== checkout) continue;
        const next: IdentityRecord = {
          ...r,
          repository,
          kind: repository === UNKNOWN_REPOSITORY
            ? r.kind
            : repository === checkout
            ? "checkout"
            : "worktree",
          availability: fact.present ? "present" : "removed",
          inventory: "current",
        };
        if (JSON.stringify(r) !== JSON.stringify(next)) records.set(k, next);
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
    records: Map<string, IdentityRecord>,
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
    const repositories = new Set(
      rows.flatMap((r) => r.repository === undefined ? [] : [r.repository]),
    );
    if (repositories.size === 1) {
      // A recorded repository outranks native project claims about this path.
      const root = [...repositories][0];
      const owners = root === UNKNOWN_REPOSITORY
        ? rows
        : this.#leaves.get(root)?.length
        ? this.#leaves.get(root)!
        : rows;
      return {
        repoID: owners.map((r) => r.repoID).sort()[0],
        canonicalRoot: root,
        leafDirectory: directory,
        ...(root === directory || root === UNKNOWN_REPOSITORY
          ? {}
          : { parentDirectory: root }),
      };
    }
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
      inventory: r.inventory,
    }));
  }
  archived(directory: string): boolean {
    const rows = this.#leaves.get(directory);
    return !!rows?.length &&
      rows.every((r) =>
        (r.kind === "worktree" || r.repository === UNKNOWN_REPOSITORY) &&
        r.inventory === "current" && r.availability === "removed"
      );
  }
  topologies(): ProjectTopology[] {
    return [...this.#leaves.keys()].flatMap((directory) =>
      this.topology(directory) ?? []
    );
  }
}

/**
 * A present checkout's own Git names its repository. A removed checkout keeps
 * its recorded repository; else retained Git registration, then OTK's stored
 * affiliation records, then `<repo>.<name>` naming of an existing repository.
 */
function recordedRepository(
  records: ReadonlyMap<string, CheckoutRecord>,
  checkout: string,
  fact: NonNullable<ProjectIdentityFact["repository"]>,
): string {
  if (fact.present && fact.root) return fact.root;
  const rows = [...records.values()];
  const sole = (values: (string | undefined)[]) => {
    const set = new Set(values.filter((v): v is string => !!v));
    return set.size === 1 ? [...set][0] : undefined;
  };
  const own = rows.filter((r) => r.leafDirectory === checkout);
  const recorded = sole(
    own.map((r) =>
      r.repository === UNKNOWN_REPOSITORY ? undefined : r.repository
    ),
  );
  if (recorded) return recorded;
  if (fact.evidence === "worktree-metadata" && fact.root) return fact.root;
  const claimed = sole(
    own.map((r) => r.canonicalRoot === checkout ? undefined : r.canonicalRoot),
  );
  if (claimed) return claimed;
  if (
    rows.some((r) =>
      r.leafDirectory !== checkout &&
      (r.canonicalRoot === checkout || r.repository === checkout)
    )
  ) return checkout;
  if (fact.evidence === "name" && fact.root) return fact.root;
  return UNKNOWN_REPOSITORY;
}
