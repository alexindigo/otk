// SPDX-License-Identifier: LGPL-3.0-only
/** Shared source-coordinate and bounded-publication unit, in source rows. */
export const HIGHLIGHT_GROUP_ROWS = 32;
/** These are explicit plain-source modes, never language auto-detection. */
export const plainLanguage = (lang?: string) =>
  !lang || ["text", "txt", "plaintext"].includes(lang);
