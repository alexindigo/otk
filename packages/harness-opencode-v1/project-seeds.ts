// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { ProjectSeed } from "@otk/harness";

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
): ProjectSeed[] {
  return db.prepare(
    `SELECT directory,COUNT(*) AS count,MAX(time_updated) AS latest FROM session WHERE directory>? ${
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
  }));
}
