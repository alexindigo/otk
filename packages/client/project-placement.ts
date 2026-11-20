// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectStatus, ProjectSummary } from "@otk/protocol";

export interface ProjectPlacement {
  section: "live" | "archived" | "inactive" | "discovered";
  annotation?: "removed";
}

/** Lifecycle and attention choose placement and wording at the same boundary. */
export function projectPlacement(input: {
  lifecycle?: Pick<ProjectSummary, "archived" | "availability">;
  status: ProjectStatus;
  inactive: boolean;
  hasSessions: boolean;
}): ProjectPlacement {
  const live = input.status === "working" || input.status === "blocked";
  const archived = input.lifecycle?.archived === true;
  const section = archived && !live
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
