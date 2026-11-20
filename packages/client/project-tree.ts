// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxProject } from "./inbox.ts";
import type { ProjectStatus } from "@otk/protocol";
import { projectLayoutKey as projectTreeKey } from "@otk/protocol";
export { projectTreeKey };

export interface ProjectBranch<T> {
  key: string;
  project: T;
  children: ProjectBranch<T>[];
  required: boolean;
}

/** One branch contract for optional rows, mandatory rows and the archive. */
export function projectBranchPresentation<T>(
  node: ProjectBranch<T>,
  open: boolean,
  archive: { count: number; status: ProjectStatus; requiredCount?: number },
): {
  children: ProjectBranch<T>[];
  protectedCount: number;
  archiveVisible: boolean;
  hasChildren: boolean;
  bodyVisible: boolean;
} {
  const children = node.children.filter((child) => open || child.required);
  const protectedCount =
    node.children.filter((child) => child.required).length +
    (archive.requiredCount ?? (archive.status !== "none" ? 1 : 0));
  const archiveVisible = archive.count > 0 &&
    (open || archive.status !== "none");
  return {
    children,
    protectedCount,
    archiveVisible,
    hasChildren: node.children.length > 0 || archive.count > 0,
    bodyVisible: children.length > 0 || archiveVisible,
  };
}

/** Topology alone owns nesting. Missing/cyclic parents remain visible roots. */
export function projectTree<
  T extends InboxProject & { sidecarId?: string },
>(
  projects: readonly T[],
): ProjectBranch<T>[] {
  const nodes = new Map(projects.map((project) => [projectTreeKey(project), {
    key: projectTreeKey(project),
    project,
    children: [] as ProjectBranch<T>[],
    required: project.status !== "none",
  }]));
  const parentKey = (project: T) => {
    const directory = project.topology?.parentDirectory ??
      project.topology?.canonicalRoot;
    return directory && directory !== project.directory
      ? projectTreeKey({ sidecarId: project.sidecarId, directory })
      : undefined;
  };
  const roots: ProjectBranch<T>[] = [];
  for (const node of nodes.values()) {
    let key = parentKey(node.project);
    const candidate = key && nodes.get(key);
    const parent = candidate &&
        candidate.project.topology?.repoID === node.project.topology?.repoID &&
        candidate.project.topology?.canonicalRoot ===
          node.project.topology?.canonicalRoot
      ? candidate
      : undefined;
    const visited = new Set([node.key]);
    while (key && !visited.has(key)) {
      visited.add(key);
      const ancestor = nodes.get(key);
      key = ancestor && parentKey(ancestor.project);
    }
    if (!parent || key) roots.push(node);
    else parent.children.push(node);
  }
  const required = (node: ProjectBranch<T>): boolean => {
    const children = node.children.map(required);
    return node.required = node.required || children.some(Boolean);
  };
  roots.forEach(required);
  return roots;
}
