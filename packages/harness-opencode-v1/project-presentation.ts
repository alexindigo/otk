// SPDX-License-Identifier: LGPL-3.0-only
import type { CatalogProject, CatalogRepository } from "@otk/protocol";
import type { Client } from "./client.ts";

const colors: Readonly<Record<string, string>> = {
  orange: "#ee7330", yellow: "#e7af36", cyan: "#0096b8", mint: "#0096b8",
  green: "#2eaf5a", lime: "#2eaf5a", red: "#d92e3c", pink: "#e4429e",
  blue: "#3250df", purple: "#623be2", gray: "#5c5c5c",
};
interface NativeProject {
  id: string; worktree: string; name?: string; vcs?: string;
  icon?: { override?: string; url?: string; color?: string };
}
export function projectPresentation(project: NativeProject): CatalogProject {
  const color = project.icon?.color;
  return {
    id: project.id,
    name: project.name,
    root: project.id === "global" || project.worktree === "/" ? undefined : project.worktree,
    icon: project.icon?.override || (color ? undefined : project.icon?.url),
    color: color ? colors[color] ?? (/^#[a-f\d]{6}$/i.test(color) ? color : undefined) : undefined,
    repository: project.vcs ? "Local repository" : undefined,
  };
}
export async function readProject(client: Client, directory: string, signal: AbortSignal): Promise<CatalogProject[]> {
  const project = await client.json<NativeProject>("/project/current", { query: { directory }, signal });
  return [projectPresentation(project)];
}
export async function readRepository(client: Client, directory: string, signal: AbortSignal): Promise<CatalogRepository[]> {
  const info = await client.json<{ branch?: string }>("/vcs", { query: { directory }, signal });
  if (!info.branch) return [];
  const status = await client.json<unknown[]>("/file/status", { query: { directory }, signal });
  const count = status.length;
  return [{ branch: info.branch, changes: count ? `${count} changed ${count === 1 ? "file" : "files"}` : "No changes" }];
}
