// SPDX-License-Identifier: LGPL-3.0-only
/** Native widgets can own their complete key stream, before global layers. */
export function localKeyboard(target?: EventTarget | null): boolean {
  return !!target && "closest" in target && !!(target as Element).closest(
    '[data-otk-keyboard="local"]',
  );
}
