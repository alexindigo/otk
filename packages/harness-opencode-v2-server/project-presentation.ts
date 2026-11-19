// SPDX-License-Identifier: LGPL-3.0-only
import type { CatalogProject, CatalogRepository } from "@otk/protocol";
import type { V2Client } from "./client.ts";

/** Native avatar variants resolved at the plugin boundary, not in shared UI. */
const colors: Readonly<Record<string, string>> = {
  orange: "#ee7330", yellow: "#e7af36", cyan: "#0096b8", mint: "#0096b8",
  green: "#2eaf5a", lime: "#2eaf5a", red: "#d92e3c", pink: "#e4429e",
  blue: "#3250df", purple: "#623be2", gray: "#5c5c5c",
};
export function projectPresentation(project: {
  id: string; canonical: string; name?: string; vcs?: string;
  icon?: { override?: string; url?: string; color?: string };
}): CatalogProject {
  const color = project.icon?.color;
  return {
    id: project.id,
    name: project.name,
    root: project.id === "global" || project.canonical === "/" ? undefined : project.canonical,
    icon: project.icon?.override || (color ? undefined : project.icon?.url),
    color: color ? colors[color] ?? (/^#[a-f\d]{6}$/i.test(color) ? color : undefined) : undefined,
    repository: project.vcs ? "Local repository" : undefined,
  };
}
export async function readProject(client: V2Client, directory: string, signal: AbortSignal): Promise<CatalogProject[]> {
  const location = await client.read((api) => api.location.get({ location: { directory } }, { signal }), signal);
  const projects = await client.read((api) => api.project.list({ archived: true }, { signal }), signal);
  const project = projects.find((project) => project.id === location.project.id);
  return project ? [projectPresentation(project)] : [];
}
export async function readRepository(client: V2Client, directory: string, signal: AbortSignal): Promise<CatalogRepository[]> {
  const input = { location: { directory } };
  const info = await client.read((api) => api.vcs.get(input, { signal }), signal);
  if (!info.data.provider) return [];
  const status = await client.read((api) => api.vcs.status(input, { signal }), signal);
  const count = status.data.length;
  return [{ branch: info.data.branch.current, changes: count ? `${count} changed ${count === 1 ? "file" : "files"}` : "No changes" }];
}
