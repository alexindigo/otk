// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";

/** Let CSS resolve custom lengths, including calc() and inherited scale tokens. */
export function cssLength(owner: Locator, token: string): Promise<number> {
  return owner.evaluate((element, token) => {
    if (!getComputedStyle(element).getPropertyValue(token).trim()) {
      throw new Error(`Missing CSS length: ${token}`);
    }
    const reference = document.createElement("span");
    Object.assign(reference.style, {
      position: "fixed",
      visibility: "hidden",
      boxSizing: "content-box",
      padding: "0",
      border: "0",
      height: `var(${token})`,
    });
    element.append(reference);
    const length = parseFloat(getComputedStyle(reference).height);
    reference.remove();
    if (!Number.isFinite(length)) {
      throw new Error(`Unresolved CSS length: ${token}`);
    }
    return length;
  }, token);
}
