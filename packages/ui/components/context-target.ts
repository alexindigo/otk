// SPDX-License-Identifier: LGPL-3.0-only
import type { ContextTarget } from "@otk/client";

const targets = new WeakMap<HTMLElement, () => ContextTarget>();

/** Declare identity/data, never event handling. Data is read at invocation. */
export function contextTarget<T>(
  target: () => ContextTarget<T>,
): (element: HTMLElement) => void {
  return (element) => {
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
