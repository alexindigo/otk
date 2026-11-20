// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxProject } from "./inbox.ts";
import { projectLayoutKey as projectTreeKey } from "@otk/protocol";
export { projectTreeKey };

export interface ProjectBranch<T> {
  key: string;
  project: T;
  children: ProjectBranch<T>[];
  required: boolean;
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
