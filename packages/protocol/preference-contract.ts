// SPDX-License-Identifier: LGPL-3.0-only
import type { DiffPreferences } from "./preferences/diff.ts";
import type { KeymapPreferences } from "./preferences/keymap.ts";
import type { NotificationPreferences } from "./preferences/notifications.ts";
import type { PromptPreferences } from "./preferences/prompt.ts";
import type { ThemePreferences } from "./preferences/theme.ts";
import type { TranscriptPreferences } from "./preferences/transcript.ts";
import type { VisualPreferences } from "./preferences/visual.ts";

/** Open contract composition; keys and policy live with their feature owners. */
export interface Preferences
  extends
    DiffPreferences,
    KeymapPreferences,
    NotificationPreferences,
    PromptPreferences,
    ThemePreferences,
    TranscriptPreferences,
    VisualPreferences {}
