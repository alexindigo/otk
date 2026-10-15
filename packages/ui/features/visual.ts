// SPDX-License-Identifier: LGPL-3.0-only
import type { Preferences } from "@otk/protocol";
/** Browser presentation only; the caller supplies authoritative host prefs. */
export function paintVisualPreferences(
  prefs: Pick<Preferences, "reducedColors" | "animationsOff">,
  doc: Document = document,
): void {
  doc.documentElement.toggleAttribute(
    "data-otk-reduced-colors",
    prefs.reducedColors,
  );
  doc.documentElement.toggleAttribute(
    "data-otk-animations-off",
    prefs.animationsOff,
  );
}
