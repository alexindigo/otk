// SPDX-License-Identifier: LGPL-3.0-only
import type { OperationContext } from "./requests.ts";
import type { RequestMetadata } from "./request-metadata.ts";

export type ProjectEditField = "name" | "icon" | "color" | "startScript";
export type ProjectPatch = Partial<Record<ProjectEditField, string>>;
export interface ProjectEditTarget {
  directory: string;
  projectID: string;
}
export interface ProjectEditSnapshot extends ProjectEditTarget {
  /** Native-provided image fallback, distinct from the editable override. */
  iconSource?: string;
  values: Record<ProjectEditField, string>;
  fields: ProjectEditField[];
  colors: { value: string; label: string; color: string }[];
  hints: { variable: string; description: string }[];
}
export interface ProjectEditCapability {
  read(directory: string, signal?: AbortSignal): Promise<ProjectEditSnapshot>;
  /** Validate location and writable fields once, before the request effect fence. */
  prepare(
    target: ProjectEditTarget,
    patch: ProjectPatch,
    signal?: AbortSignal,
  ): Promise<(operation?: OperationContext) => Promise<ProjectEditSnapshot>>;
}
export interface ProjectEditCapabilities {
  projectEdit: ProjectEditCapability;
}
export interface ProjectEditRpcMethods {
  "project.settings": {
    params: { directory: string };
    result: ProjectEditSnapshot;
  };
  "project.update": {
    params: ProjectEditTarget & { patch: ProjectPatch };
    result: null;
  };
}
export interface ProjectEditRequestReceipts {
  "project-edit-intent": ProjectEditTarget & {
    hashes: Partial<Record<ProjectEditField, string>>;
  };
  "project-edited": ProjectEditTarget;
}
export const projectEditRequestMetadata: Readonly<
  Record<string, RequestMetadata>
> = {
  "project.settings": { kind: "read", pending: "Loading project settings" },
  "project.update": { kind: "mutation", pending: "Saving project settings" },
};
