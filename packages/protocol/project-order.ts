// SPDX-License-Identifier: LGPL-3.0-only
export interface ProjectOrderEntry {
  id: string;
  /** Canonical checkout first, then retained aliases in admission order. */
  directories: string[];
}

export interface ProjectOrderFrame {
  t: "projects.order";
  revision: number;
  projects: ProjectOrderEntry[];
}

export type ProjectMoveTarget = { before: string } | { after: string };
export type ProjectMove = { id: string } & ProjectMoveTarget;
