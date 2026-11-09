// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { ProjectSeed } from "@otk/harness";
import type { ProjectTopology } from "@otk/protocol";

export interface NativeProjectRoot {
  id: string;
  worktree: string;
  sandboxes?: string[];
}
/** V1 uses one project ID across its canonical checkout and registered sandboxes. */
export function projectTopology(
  projects: readonly NativeProjectRoot[],
  id: string,
  directory: string,
): ProjectTopology | undefined {
  const project = projects.find((p) => p.id === id);
  if (!project || id === "global" || project.worktree === "/") return;
  const leaf =
    [project.worktree, ...project.sandboxes ?? []].filter((root) =>
      directory === root || directory.startsWith(root + "/")
    ).sort((a, b) => b.length - a.length)[0];
  if (!leaf) return;
  return {
    repoID: id,
    canonicalRoot: project.worktree,
    leafDirectory: leaf,
    ...(leaf !== project.worktree ? { parentDirectory: project.worktree } : {}),
  };
}

/** Without a session repo ID, only unique exact inventory membership proves ownership. */
export function projectTopologyAt(
  projects: readonly NativeProjectRoot[],
  directory: string,
): ProjectTopology | null {
  const owners = projects.filter((p) =>
    p.worktree === directory || p.sandboxes?.includes(directory)
  );
  return owners.length === 1
    ? projectTopology(projects, owners[0].id, directory) ?? null
    : null;
}

/** Project-table proof is deliberately independent of session identity samples. */
export function projectFileMatches(
  db: DatabaseSync,
  projects: readonly { id: string; worktree: string }[],
): boolean {
  const rows = db.prepare("SELECT id,worktree FROM project ORDER BY id").all();
  return rows.length === projects.length &&
    projects.every((project) =>
      rows.some((row) =>
        row.id === project.id && row.worktree === project.worktree
      )
    );
}

/** Grouped scalar rows only: no session catalog, header or helper acquisition. */
export function projectSeeds(
  db: DatabaseSync,
  after: string,
  limit: number,
  directory?: string,
  projects: readonly NativeProjectRoot[] = [],
): ProjectSeed[] {
  return db.prepare(
    `SELECT directory,MIN(project_id) AS project_id,COUNT(DISTINCT project_id) AS repos,COUNT(*) AS count,MAX(time_updated) AS latest FROM session WHERE directory>? ${
      directory === undefined ? "" : "AND directory=?"
    } GROUP BY directory ORDER BY directory LIMIT ?`,
  ).all(
    ...(directory === undefined ? [after, limit] : [after, directory, limit]),
  ).map((row) => ({
    directory: String(row.directory),
    hasSessions: Number(row.count) > 0,
    sessionCount: Number(row.count),
    lastActivity: Number(row.latest),
    authority: "current",
    topology: Number(row.repos) === 1
      ? projectTopology(
        projects,
        String(row.project_id),
        String(row.directory),
      ) ?? null
      : null,
  }));
}
