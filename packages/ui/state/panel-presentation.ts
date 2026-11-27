// SPDX-License-Identifier: LGPL-3.0-only
import type { ShellLayout } from "@otk/protocol";
import { SHELL_WIDTHS } from "@otk/protocol";
import { createMemo, createSignal, onSettled } from "solid-js";

export type PanelPresentation = "inline" | "sheet";

export function panelMode(input: {
  app: number;
  left: number;
  leftCollapsed: boolean;
  rail: number;
  right: number;
  mainMin: number;
  open: boolean;
}): PanelPresentation {
  const left = input.leftCollapsed ? input.rail : input.left;
  return input.open && input.app - left - input.right < input.mainMin
    ? "sheet"
    : "inline";
}

/** Compare the whole shell with the saved column sizes, never with a
 * conversation width that's already affected by this presentation. */
export function createPanelPresentation(input: {
  app(): HTMLElement | undefined;
  leftRail(): HTMLElement | undefined;
  layout(): ShellLayout;
}) {
  const [geometry, setGeometry] = createSignal<{
    app: number;
    rail: number;
    mainMin: number;
  }>();
  const measure = () => {
    const app = input.app(), rail = input.leftRail();
    if (!app || !rail) return;
    setGeometry({
      app: app.getBoundingClientRect().width,
      rail: rail.getBoundingClientRect().width,
      mainMin: parseFloat(getComputedStyle(app).getPropertyValue("--main-min")),
    });
  };
  onSettled(() => {
    const app = input.app(), rail = input.leftRail();
    if (!app || !rail) return;
    const observer = new ResizeObserver(measure);
    observer.observe(app);
    observer.observe(rail);
    measure();
    return () => observer.disconnect();
  });
  const mode = createMemo((): PanelPresentation => {
    const size = geometry();
    if (!size) return "inline";
    const layout = input.layout();
    return panelMode({
      ...size,
      left: layout.leftWidth,
      leftCollapsed: layout.leftCollapsed,
      right: layout.rightWidth ?? SHELL_WIDTHS.right.default,
      open: !layout.rightCollapsed,
    });
  });
  return { mode, measure };
}
