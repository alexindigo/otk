// SPDX-License-Identifier: LGPL-3.0-only
import type { PreferenceRegistry } from "../prefs.ts";
import type { Preferences } from "../preference-contract.ts";
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
export interface ShellLayout {
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightWidth?: number;
  rightView?: string;
  discoveredCollapsed?: boolean;
  projectLocations?: ProjectLocation[];
}
export interface LayoutPreferences {
  shellLayout: ShellLayout;
}
export interface LayoutRpcMethods {
  "layout.patch": { params: Partial<ShellLayout>; result: Preferences };
  "layout.location": { params: ProjectLocation; result: Preferences };
}
export function isProjectLocation(value: unknown): value is ProjectLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const location = value as Record<string, unknown>;
  return Object.keys(location).every((key) =>
    ["sidecarId", "directory", "sessionID"].includes(key)
  ) && typeof location.sidecarId === "string" && !!location.sidecarId &&
    typeof location.directory === "string" && !!location.directory &&
    (location.sessionID === undefined ||
      (typeof location.sessionID === "string" && !!location.sessionID));
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
        (layout.projectLocations === undefined ||
          (Array.isArray(layout.projectLocations) &&
            layout.projectLocations.every(isProjectLocation) &&
            new Set(
                layout.projectLocations.map((p) =>
                  JSON.stringify([p.sidecarId, p.directory])
                ),
              ).size === layout.projectLocations.length)) &&
        (layout.rightView === undefined ||
          (typeof layout.rightView === "string" &&
            layout.rightView.length <= 128));
    },
  });
}
