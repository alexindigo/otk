// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { ProjectIdentityFact, ProjectSeed } from "@otk/harness";
import type { ProjectTopology } from "@otk/protocol";
import { projectPresentation } from "./project-presentation.ts";

export interface NativeProjectRoot {
  id: string;
  worktree: string;
  sandboxes?: string[];
  name?: string;
  icon?: { color?: string };
}
function presentation(
  project: NativeProjectRoot,
): NonNullable<ProjectSeed["presentation"]> {
  const { id, name, color } = projectPresentation(project);
  return { id, name, color };
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

/** Exact inventory owners supplement population, never another owner's prefix. */
export function projectOwnerFacts(
  directory: string,
  projects: readonly NativeProjectRoot[],
  source: string,
  population: readonly { repoID: string; root: string | null }[] = [],
): ProjectIdentityFact[] {
  const owners = new Map(population.map((row) => [row.repoID, row.root]));
  for (const project of projects) {
    if (project.id === "global" || project.worktree === "/") continue;
    if (
      (project.worktree === directory ||
        project.sandboxes?.includes(directory)) && !owners.has(project.id)
    ) owners.set(project.id, directory);
  }
  return [...owners].map(([repoID, root]) => {
    const project = projects.find((p) => p.id === repoID);
    if (repoID === "global" || project?.worktree === "/") {
      return { source, repoID, recordedRoot: null };
    }
    if (!project) return { source, repoID, recordedRoot: root };
    return {
      source,
      repoID,
      canonicalRoot: project.worktree,
      recordedRoot: root,
      inventory: [
        { directory: project.worktree, kind: "checkout" },
        ...(project.sandboxes ?? []).map((directory) => ({
          directory,
          kind: "unknown" as const,
        })),
      ],
    };
  });
}
export function emptyProjectSeed(
  directory: string,
  projects: readonly NativeProjectRoot[],
  source: string,
): ProjectSeed {
  const identities = projectOwnerFacts(directory, projects, source);
  const owner = identities.length === 1
    ? projects.find((project) => project.id === identities[0].repoID)
    : undefined;
  return {
    directory,
    ...(owner ? { presentation: presentation(owner) } : {}),
    hasSessions: false,
    sessionCount: 0,
    lastActivity: null,
    authority: "current",
    ...(identities.length ? { identities } : {}),
    topology: projectTopologyAt(projects, directory) ?? undefined,
  };
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
  ).map((row) => {
    const identities = projectOwnerFacts(
      String(row.directory),
      projects,
      source,
      JSON.parse(String(row.owners)),
    );
    const owner = identities.length === 1
      ? projects.find((project) => project.id === identities[0].repoID)
      : undefined;
    return {
      directory: String(row.directory),
      ...(owner ? { presentation: presentation(owner) } : {}),
      hasSessions: Number(row.count) > 0,
      sessionCount: Number(row.count),
      lastActivity: Number(row.latest),
      authority: "current",
      identities,
      topology: identities.length === 1
        ? projectTopology(
          projects,
          identities[0].repoID,
          String(row.directory),
        ) ?? null
        : null,
    };
  });
}
