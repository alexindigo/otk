// SPDX-License-Identifier: LGPL-3.0-only
export interface ProjectSelection {
  sidecarId: string;
  directory: string;
}
export function projectHash(project: ProjectSelection): string {
  return `#project/${encodeURIComponent(project.sidecarId)}/${
    encodeURIComponent(project.directory)
  }`;
}
export function projectRoute(hash: string): ProjectSelection | undefined {
  const match = /^#project\/([^/]+)\/([^/]+)$/.exec(hash);
  if (!match) return;
  try {
    return {
      sidecarId: decodeURIComponent(match[1]),
      directory: decodeURIComponent(match[2]),
    };
  } catch {
    return;
  }
}
export function shellTitle(
  title: string | undefined,
  project: string | undefined,
): string {
  return [title, project, "OTK"].filter(Boolean).join(" — ");
}
