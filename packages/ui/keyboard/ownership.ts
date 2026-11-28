// SPDX-License-Identifier: LGPL-3.0-only
/** Native widgets can own their complete key stream, before global layers. */
export function localKeyboard(target?: EventTarget | null): boolean {
  return !!target && "closest" in target && !!(target as Element).closest(
    '[data-otk-keyboard="local"]',
  );
}

/** Native text inputs retain editing and selection, unlike other form controls. */
export function nativeTextField(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement &&
      ["text", "search", "tel", "url", "email", "password", "number"].includes(
        node.type,
      )) ||
    (node instanceof HTMLElement && node.isContentEditable);
}
