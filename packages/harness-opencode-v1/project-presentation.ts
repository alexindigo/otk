// SPDX-License-Identifier: LGPL-3.0-only
import type { CatalogProject, CatalogRepository } from "@otk/protocol";
import type { Client } from "./client.ts";
import { HarnessError, projectMetadata } from "@otk/harness";

export const projectColors: Readonly<Record<string, string>> = {
  orange: "#ee7330",
  yellow: "#e7af36",
  cyan: "#0096b8",
  mint: "#0096b8",
  green: "#2eaf5a",
  lime: "#2eaf5a",
  red: "#d92e3c",
  pink: "#e4429e",
  blue: "#3250df",
  purple: "#623be2",
  gray: "#5c5c5c",
};
export interface NativeProject {
  id: string;
  worktree: string;
  name?: string;
  vcs?: string;
  icon?: { override?: string; url?: string; color?: string };
  commands?: { start?: string };
}
export function nativeProjectMetadata(project: Record<string, unknown>) {
  return projectMetadata(project, "worktree", (value) => {
    const { id, name, color } = projectPresentation({
      ...value,
      worktree: "/",
    });
    return { id, name, color };
  });
}
export function projectPresentation(project: NativeProject): CatalogProject {
  const color = project.icon?.color;
  return {
    id: project.id,
    name: project.name,
    root: project.id === "global" || project.worktree === "/"
      ? undefined
      : project.worktree,
    icon: project.icon?.override || (color ? undefined : project.icon?.url),
    color: color
      ? projectColors[color] ??
        (/^#[a-f\d]{6}$/i.test(color) ? color : undefined)
      : undefined,
    repository: project.vcs ? "Local repository" : undefined,
  };
}
export async function readProject(
  client: Client,
  directory: string,
  signal: AbortSignal,
): Promise<CatalogProject[]> {
  return [
    projectPresentation(await readNativeProject(client, directory, signal)),
  ];
}
/** Current selects identity; its cached fields are not mutable metadata authority. */
export async function readNativeProject(
  client: Client,
  directory: string,
  signal?: AbortSignal,
): Promise<NativeProject> {
  const current = await client.json<{ id: string }>("/project/current", {
    query: { directory },
    signal,
  });
  const projects = await client.json<NativeProject[]>("/project", { signal });
  const project = projects.find((project) => project.id === current.id);
  if (!project) {
    throw new HarnessError(
      "project.missing",
      "That project is no longer available.",
    );
  }
  return project;
}
export async function readRepository(
  client: Client,
  directory: string,
  signal: AbortSignal,
): Promise<CatalogRepository[]> {
  const info = await client.json<{ branch?: string }>("/vcs", {
    query: { directory },
    signal,
  });
  if (!info.branch) return [];
  const status = await client.json<unknown[]>("/file/status", {
    query: { directory },
    signal,
  });
  const count = status.length;
  return [{
    branch: info.branch,
    changes: count
      ? `${count} changed ${count === 1 ? "file" : "files"}`
      : "No changes",
  }];
}
