// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ProjectStatus,
  type ProjectSummary,
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
  inactive: boolean;
  hasSessions: boolean;
}): ProjectPlacement {
  const live = input.status === "working" || input.status === "blocked";
  const archived = input.lifecycle?.archived === true;
  // Without a repository there is no live parent: it is never a project row.
  const unknown =
    input.lifecycle?.topology?.canonicalRoot === UNKNOWN_REPOSITORY;
  const section = unknown || archived && !live
    ? "archived"
    : input.inactive && input.status === "none"
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
  return summary.topology?.repoID ?? summary.topology?.canonicalRoot ??
    summary.directory;
}
