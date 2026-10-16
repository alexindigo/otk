// SPDX-License-Identifier: LGPL-3.0-only
import type { PreferenceRegistry } from "../prefs.ts";
import type { Preferences } from "../preference-contract.ts";
export interface ShellLayout {
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightWidth?: number;
  rightView?: string;
}
export interface LayoutPreferences {
  shellLayout: ShellLayout;
}
export interface LayoutRpcMethods {
  "layout.patch": { params: Partial<ShellLayout>; result: Preferences };
}
export function registerLayoutPreferences(registry: PreferenceRegistry): void {
  registry.register({
    key: "shellLayout",
    label: "Panel layout",
    default: {
      leftWidth: 248,
      leftCollapsed: false,
      rightCollapsed: true,
      rightWidth: 320,
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
        ].includes(key)
      ) &&
        typeof layout.leftWidth === "number" &&
        Number.isFinite(layout.leftWidth) &&
        layout.leftWidth >= 200 && layout.leftWidth <= 360 &&
        typeof layout.leftCollapsed === "boolean" &&
        typeof layout.rightCollapsed === "boolean" &&
        (layout.rightWidth === undefined ||
          (typeof layout.rightWidth === "number" &&
            Number.isFinite(layout.rightWidth) &&
            layout.rightWidth >= 280 && layout.rightWidth <= 480)) &&
        (layout.rightView === undefined ||
          (typeof layout.rightView === "string" &&
            layout.rightView.length <= 128));
    },
  });
}
