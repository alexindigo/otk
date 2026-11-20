// SPDX-License-Identifier: MIT
import { isMacPlatform } from "./platform.ts";
import { ghosttyKeyboardCodes } from "./key-names.ts";

// From T3 packages/shared/src/keybindings.ts, same source revision.
const US_SHIFTED_TO_UNSHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

const codeToGhosttyKey = new Map<string, number>(
  ghosttyKeyboardCodes.map((code, index) => [code, index]),
);

export function ghosttyKeyForCode(code: string): number {
  return codeToGhosttyKey.get(code) ?? 0;
}

export function ghosttyKeyForEvent(
  event: Pick<KeyboardEvent, "code" | "key">,
): number {
  // Android browsers can omit the physical code for keys such as Backspace.
  return ghosttyKeyForCode(event.code) || ghosttyKeyForCode(event.key);
}

export interface GhosttyKeyboardLayoutMap {
  get(code: string): string | undefined;
}

let keyboardLayoutMapPromise:
  | Promise<GhosttyKeyboardLayoutMap | undefined>
  | undefined;

export function loadGhosttyKeyboardLayoutMap(): Promise<
  GhosttyKeyboardLayoutMap | undefined
> {
  if (keyboardLayoutMapPromise) return keyboardLayoutMapPromise;
  const browserNavigator = globalThis.navigator as
    | (Navigator & {
      readonly keyboard?: { getLayoutMap(): Promise<GhosttyKeyboardLayoutMap> };
    })
    | undefined;
  const promise =
    browserNavigator?.keyboard?.getLayoutMap().catch(() => undefined) ??
      Promise.resolve(undefined);
  keyboardLayoutMapPromise = promise;
  return promise;
}

export function ghosttyConsumedMods(
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
  platform = navigator.platform,
): number {
  if (event.ctrlKey || event.metaKey || [...event.key].length !== 1) return 0;
  if (event.altKey && !isMacPlatform(platform)) return 0;
  return (event.shiftKey ? 1 : 0) | (event.altKey ? 1 << 2 : 0);
}

export function ghosttyUnshiftedCodepoint(
  event: Pick<KeyboardEvent, "code" | "key" | "shiftKey">,
  layoutMap?: GhosttyKeyboardLayoutMap,
): number {
  if ([...event.key].length !== 1) return 0;
  const layoutCharacter = layoutMap?.get(event.code);
  if (layoutCharacter && [...layoutCharacter].length === 1) {
    return layoutCharacter.codePointAt(0) ?? 0;
  }
  if (/^[A-Z]$/u.test(event.key)) return event.key.charCodeAt(0) + 32;
  if (event.shiftKey) {
    const unshiftedCharacter = US_SHIFTED_TO_UNSHIFTED_KEYS.get(event.key);
    if (unshiftedCharacter) return unshiftedCharacter.codePointAt(0) ?? 0;
    const lowercase = event.key.toLowerCase();
    if (lowercase !== event.key && [...lowercase].length === 1) {
      return lowercase.codePointAt(0) ?? 0;
    }
    // Without layout data, guessing corrupts Kitty alternate keys.
    return 0;
  }
  return event.key.codePointAt(0) ?? 0;
}
