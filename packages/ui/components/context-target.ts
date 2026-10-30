// SPDX-License-Identifier: LGPL-3.0-only
import type { ContextTarget } from "@otk/client";
import { onCleanup } from "solid-js";

const targets = new WeakMap<HTMLElement, () => ContextTarget>();

/** Declare identity/data, never event handling. Data is read at invocation. */
export function contextTarget<T>(
  target: () => ContextTarget<T>,
): (element: HTMLElement) => void {
  const elements = new Set<HTMLElement>();
  // Capture the rendering owner now: native ref callbacks run at commit time,
  // outside the component's reactive ownership scope.
  onCleanup(() => {
    for (const element of elements) {
      if (targets.get(element) === target) targets.delete(element);
    }
    elements.clear();
  });
  return (element) => {
    elements.add(element);
    targets.set(element, target);
  };
}

/** Only the app-wide owner resolves the composed ancestor path. */
export function contextTargets(path: readonly EventTarget[]): ContextTarget[] {
  return path.flatMap((node) => {
    const target = node instanceof HTMLElement ? targets.get(node) : undefined;
    return target ? [target()] : [];
  });
}
