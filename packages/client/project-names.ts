// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CapabilityName,
  type ProjectSummary,
  UNKNOWN_REPOSITORY,
} from "@otk/protocol";

type Facts = Pick<ProjectSummary, "presentation" | "topology"> | undefined;

/** The default when the native project has no name. */
export function folderName(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;
}

/** The canonical checkout shows the native project name; a worktree shows its folder. */
export function checkoutLabel(directory: string, summary: Facts): string {
  const worktree = !!summary?.topology &&
    summary.topology.canonicalRoot !== directory;
  return worktree ? folderName(directory) : projectLabel(directory, summary);
}

/** The project a checkout belongs to, even when viewing a worktree. */
export function projectLabel(directory: string, summary: Facts): string {
  const root = summary?.topology?.canonicalRoot;
  return summary?.presentation?.name ||
    folderName(root && root !== UNKNOWN_REPOSITORY ? root : directory);
}

export function canRenameProject(row: {
  level?: "project" | "worktree";
  group?: string;
  summary?: Facts;
}, capabilities: readonly CapabilityName[]): boolean {
  const id = row.summary?.presentation?.id;
  return capabilities.includes("projectEdit") && row.level === "project" &&
    row.group !== "discovered" && !!id && id !== "global";
}
