// SPDX-License-Identifier: LGPL-3.0-only
import type { PreferenceRegistry } from "../prefs.ts";
export interface ShellLayout {
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}
export interface LayoutPreferences {
  shellLayout: ShellLayout;
}
export function registerLayoutPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "shellLayout",
    label: "Panel layout",
    default: { leftWidth: 248, leftCollapsed: false, rightCollapsed: true },
    validate: (value): value is ShellLayout => {
      if (
        !value || typeof value !== "object" || Array.isArray(value)
      ) return false;
      const layout = value as Record<string, unknown>;
      return Object.keys(layout).length === 3 &&
        typeof layout.leftWidth === "number" &&
        Number.isFinite(layout.leftWidth) &&
        layout.leftWidth >= 200 && layout.leftWidth <= 360 &&
        typeof layout.leftCollapsed === "boolean" &&
        typeof layout.rightCollapsed === "boolean";
    },
  });
}
