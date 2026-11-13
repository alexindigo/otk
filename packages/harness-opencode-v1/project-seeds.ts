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
  source = "opencode-v1",
): ProjectSeed[] {
  const history = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_directory'",
  ).get();
  const root = history
    ? `(SELECT pd.directory FROM project_directory pd WHERE pd.project_id=s.project_id AND (s.directory=pd.directory OR substr(s.directory,1,length(pd.directory)+1)=pd.directory||'/') ORDER BY length(pd.directory) DESC LIMIT 1)`
    : "NULL";
  return db.prepare(
    `SELECT directory,MIN(project_id) AS project_id,COUNT(DISTINCT project_id) AS repos,json_group_array(json_object('repoID',project_id,'root',root)) AS owners,SUM(count) AS count,MAX(latest) AS latest FROM (SELECT s.directory,s.project_id,${root} AS root,COUNT(*) AS count,MAX(time_updated) AS latest FROM session s WHERE s.directory>? ${
      directory === undefined ? "" : "AND directory=?"
    } GROUP BY s.project_id,s.directory) GROUP BY directory ORDER BY directory LIMIT ?`,
  ).all(
    ...(directory === undefined ? [after, limit] : [after, directory, limit]),
  ).map((row) => ({
    directory: String(row.directory),
    hasSessions: Number(row.count) > 0,
    sessionCount: Number(row.count),
    lastActivity: Number(row.latest),
    authority: "current",
    identities: (JSON.parse(String(row.owners)) as {
      repoID: string;
      root: string | null;
    }[]).flatMap((owner) => {
      const project = projects.find((p) => p.id === owner.repoID);
      if (owner.repoID === "global" || project?.worktree === "/") {
        return [{ source, repoID: owner.repoID, recordedRoot: null }];
      }
      if (!project) {
        return [{ source, repoID: owner.repoID, recordedRoot: owner.root }];
      }
      return [{
        source,
        repoID: project.id,
        canonicalRoot: project.worktree,
        recordedRoot: owner.root,
        inventory: [
          { directory: project.worktree, kind: "checkout" as const },
          ...(project.sandboxes ?? []).map((directory) => ({
            directory,
            // V1's sandbox list also contains independent clones. It proves
            // registration, not Git-worktree kind.
            kind: "unknown" as const,
          })),
        ],
      }];
    }),
    topology: Number(row.repos) === 1
      ? projectTopology(
        projects,
        String(row.project_id),
        String(row.directory),
      ) ?? null
      : null,
  }));
}
