// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ProjectStatus,
  type ProjectSummary,
  remoteProjectGroup,
  UNKNOWN_REPOSITORY,
} from "./inbox.ts";

export interface ProjectPlacement {
  section: "live" | "archived" | "inactive" | "discovered";
  annotation?: "removed";
}

/** Lifecycle and attention choose placement and wording at the same boundary. */
export function projectPlacement(input: {
  lifecycle?: Pick<ProjectSummary, "archived" | "availability" | "topology">;
  status: ProjectStatus;
  dependencies?: number;
  liveWork?: true;
  inactive: boolean;
  hasSessions: boolean;
}): ProjectPlacement {
  const live = input.liveWork || input.status === "working" ||
    input.status === "blocked" ||
    input.status === "dependencies" || (input.dependencies ?? 0) > 0;
  const archived = input.lifecycle?.archived === true;
  // Without a repository there is no live parent: it is never a project row.
  const unknown =
    input.lifecycle?.topology?.canonicalRoot === UNKNOWN_REPOSITORY;
  const child = input.lifecycle?.topology;
  const groupedChild = child?.parentDirectory && remoteProjectGroup(child);
  const section = unknown || archived && !live
    ? "archived"
    : input.inactive && !groupedChild && input.status === "none"
    ? "inactive"
    : input.hasSessions || input.status !== "none"
    ? "live"
    : "discovered";
  return {
    section,
    annotation: input.lifecycle?.availability === "removed"
      ? "removed"
      : undefined,
  };
}

/** The archive belongs to the repository; unproven identities remain local. */
export function archiveEntityID(
  summary: Pick<ProjectSummary, "directory" | "topology">,
): string {
  if (summary.topology?.canonicalRoot === UNKNOWN_REPOSITORY) {
    return UNKNOWN_REPOSITORY;
  }
  return remoteProjectGroup(summary.topology) ?? summary.topology?.repoID ??
    summary.topology?.canonicalRoot ??
    summary.directory;
}
