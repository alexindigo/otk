// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "../request-metadata.ts";
export const layoutRequestMetadata: Readonly<Record<string, RequestMetadata>> =
  {
    "navigation.default": { kind: "read", pending: "Opening project" },
    "layout.patch": { kind: "mutation", pending: "Saving layout" },
    "layout.project": {
      kind: "mutation",
      pending: "Saving project tree",
      presentation: "bookkeeping",
    },
    "layout.tree": {
      kind: "mutation",
      pending: "Saving session tree",
      presentation: "bookkeeping",
    },
    "layout.location": {
      kind: "mutation",
      pending: "Saving location",
      presentation: "bookkeeping",
    },
  };
import type { PreferenceRegistry } from "../prefs.ts";
import type { Preferences } from "../preference-contract.ts";
import { isSessionID } from "../session-id.ts";
/** Persisted column widths, shared by validation and interactive consumers. */
export const SHELL_WIDTHS = Object.freeze({
  left: Object.freeze({ min: 200, max: 360, default: 248 }),
  right: Object.freeze({ min: 280, max: 480, default: 320 }),
});
export interface ProjectLocation {
  sidecarId: string;
  directory: string;
  sessionID?: string;
}
/** Shared identity for persisted project-view state and client tree branches. */
export function projectLayoutKey(
  project: { sidecarId?: string; directory: string },
): string {
  return JSON.stringify([project.sidecarId, project.directory]);
}
export interface ShellLayout {
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightWidth?: number;
  rightView?: string;
  discoveredCollapsed?: boolean;
  projectCollapsed?: Record<string, boolean>;
  treeCollapsed?: Record<string, true>;
  projectLocations?: ProjectLocation[];
}
export type SessionTreeKind = "task" | "ungrouped" | "session";
export function isSessionTreeKind(value: unknown): value is SessionTreeKind {
  return value === "task" || value === "ungrouped" || value === "session";
}
export interface SessionTreeTarget {
  sidecarId: string;
  kind: SessionTreeKind;
  id: string;
}
export function treeLayoutKey(target: SessionTreeTarget): string {
  return JSON.stringify([target.sidecarId, target.kind, target.id]);
}
export interface LayoutPreferences {
  shellLayout: ShellLayout;
}
export interface LayoutRpcMethods {
  "navigation.default": {
    params: { directory: string; preferred?: string; attention?: boolean };
    result: string | null;
  };
  "layout.patch": { params: Partial<ShellLayout>; result: Preferences };
  "layout.project": {
    params: { sidecarId: string; directory: string; collapsed: boolean };
    result: Preferences;
  };
  "layout.location": { params: ProjectLocation; result: Preferences };
  "layout.tree": {
    params: SessionTreeTarget & { collapsed: boolean };
    result: Preferences;
  };
}
export function isProjectLocation(value: unknown): value is ProjectLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const location = value as Record<string, unknown>;
  return Object.keys(location).every((key) =>
    ["sidecarId", "directory", "sessionID"].includes(key)
  ) && typeof location.sidecarId === "string" && !!location.sidecarId &&
    typeof location.directory === "string" && !!location.directory &&
    (location.sessionID === undefined ||
      isSessionID(location.sessionID));
}
export function registerLayoutPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "shellLayout",
    label: "Panel layout",
    default: {
      leftWidth: SHELL_WIDTHS.left.default,
      leftCollapsed: false,
      rightCollapsed: true,
      rightWidth: SHELL_WIDTHS.right.default,
      rightView: "",
    },
    validate: (value): value is ShellLayout => {
      if (
        !value || typeof value !== "object" || Array.isArray(value)
      ) return false;
      const layout = value as Record<string, unknown>;
      return Object.keys(layout).every((key) =>
        [
          "leftWidth",
          "leftCollapsed",
          "rightCollapsed",
          "rightWidth",
          "rightView",
          "discoveredCollapsed",
          "projectCollapsed",
          "treeCollapsed",
          "projectLocations",
        ].includes(key)
      ) &&
        typeof layout.leftWidth === "number" &&
        Number.isFinite(layout.leftWidth) &&
        layout.leftWidth >= SHELL_WIDTHS.left.min &&
        layout.leftWidth <= SHELL_WIDTHS.left.max &&
        typeof layout.leftCollapsed === "boolean" &&
        typeof layout.rightCollapsed === "boolean" &&
        (layout.rightWidth === undefined ||
          (typeof layout.rightWidth === "number" &&
            Number.isFinite(layout.rightWidth) &&
            layout.rightWidth >= SHELL_WIDTHS.right.min &&
            layout.rightWidth <= SHELL_WIDTHS.right.max)) &&
        (layout.discoveredCollapsed === undefined ||
          typeof layout.discoveredCollapsed === "boolean") &&
        (layout.projectCollapsed === undefined ||
          (!!layout.projectCollapsed &&
            typeof layout.projectCollapsed === "object" &&
            !Array.isArray(layout.projectCollapsed) &&
            Object.values(layout.projectCollapsed).every((value) =>
              typeof value === "boolean"
            ))) &&
        (layout.projectLocations === undefined ||
          (Array.isArray(layout.projectLocations) &&
            layout.projectLocations.every(isProjectLocation) &&
            new Set(
                layout.projectLocations.map((p) => projectLayoutKey(p)),
              ).size === layout.projectLocations.length)) &&
        (layout.treeCollapsed === undefined ||
          (!!layout.treeCollapsed &&
            typeof layout.treeCollapsed === "object" &&
            !Array.isArray(layout.treeCollapsed) &&
            Object.values(layout.treeCollapsed).every((value) =>
              value === true
            ))) &&
        (layout.rightView === undefined ||
          (typeof layout.rightView === "string" &&
            layout.rightView.length <= 128));
    },
  });
}
