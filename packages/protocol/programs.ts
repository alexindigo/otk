// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectMoveTarget } from "./project-order.ts";

/** Aggregate identity of the final, unassigned section ("Other"). */
export const OTHER_PROGRAM_ID = "none";

export interface Program {
  id: string;
  name: string;
  named: boolean;
  origin: "user" | "auto";
  owner?: string;
}
export interface ProgramMembership {
  program: string | null;
  by: "user" | "auto";
}
export interface ProgramsFrame {
  t: "programs";
  revision: number;
  auto: boolean;
  programs: Program[];
  members: Record<string, ProgramMembership>;
}
export interface ProgramCreate {
  name: string;
  projects?: string[];
}
export type ProgramMove = { id: string } & ProjectMoveTarget;
export type ProgramAssign = {
  project: string;
  program: string | null;
} & (ProjectMoveTarget | { before?: never; after?: never });
