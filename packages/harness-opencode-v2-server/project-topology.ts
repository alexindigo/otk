// SPDX-License-Identifier: LGPL-3.0-only
import type { ProjectTopology } from "@otk/protocol";

export interface NativeProjectTopology {
  id: string;
  canonical: string;
  /** Undefined means inventory failed, not a complete empty inventory. */
  worktrees?: readonly { directory: string }[];
}

/** Native project identity bounds path matching; exact session scopes stay intact. */
export class V2ProjectTopology {
  readonly #projects = new Map<string, NativeProjectTopology>();
  constructor(projects: readonly NativeProjectTopology[]) {
    for (const project of projects) this.#projects.set(project.id, project);
  }
  roots(): string[] {
    return [
      ...new Set(
        [...this.#projects.values()].flatMap((
          project,
        ) => [
          project.canonical,
          ...(project.worktrees ?? []).map((row) => row.directory),
        ]),
      ),
    ];
  }
  resolve(
    directory: string,
    projectID?: string,
  ): ProjectTopology | null | undefined {
    // A scope shared by several native projects has no single repo relationship.
    if (!projectID) return null;
    const project = this.#projects.get(projectID);
    if (!project) return null;
    if (!project.worktrees) return undefined;
    const roots = [
      project.canonical,
      ...project.worktrees.map((row) => row.directory),
    ];
    const leafDirectory = roots.filter((root) =>
      directory === root ||
      directory.startsWith(root.endsWith("/") ? root : root + "/")
    ).sort((a, b) => b.length - a.length)[0];
    if (!leafDirectory) return null;
    return {
      repoID: project.id,
      canonicalRoot: project.canonical,
      leafDirectory,
      ...(leafDirectory === project.canonical
        ? {}
        : { parentDirectory: project.canonical }),
    };
  }
  /** Only exact native inventory roots can establish an otherwise empty scope. */
  root(directory: string): ProjectTopology | null | undefined {
    const owners = [...this.#projects.values()].filter((project) =>
      project.canonical === directory ||
      project.worktrees?.some((row) => row.directory === directory)
    );
    return owners.length === 1 ? this.resolve(directory, owners[0].id) : null;
  }
}
