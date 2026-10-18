// SPDX-License-Identifier: LGPL-3.0-only
import { PreferenceRegistry } from "./prefs.ts";
import type { Preferences } from "./preference-contract.ts";
import { registerDiffPreferences } from "./preferences/diff.ts";
import { registerInboxPreferences } from "./preferences/inbox.ts";
import { registerLayoutPreferences } from "./preferences/layout.ts";
import { registerKeymapPreferences } from "./preferences/keymap.ts";
import { registerModelPreferences } from "./preferences/models.ts";
import { registerNotificationPreferences } from "./preferences/notifications.ts";
import { registerPromptPreferences } from "./preferences/prompt.ts";
import { registerThemePreferences } from "./preferences/theme.ts";
import { registerTranscriptPreferences } from "./preferences/transcript.ts";
import { registerVisualPreferences } from "./preferences/visual.ts";

/** Shipped composition selects owners, never individual keys or validators. */
export function createPreferences(): PreferenceRegistry {
  const registry = new PreferenceRegistry();
  registerNotificationPreferences(registry);
  registerThemePreferences(registry);
  registerKeymapPreferences(registry);
  registerTranscriptPreferences(registry);
  registerDiffPreferences(registry);
  registerPromptPreferences(registry);
  registerModelPreferences(registry);
  registerVisualPreferences(registry);
  registerInboxPreferences(registry);
  registerLayoutPreferences(registry);
  return registry;
}
export const preferences: PreferenceRegistry = createPreferences();
export const DEFAULT_PREFS: Readonly<Preferences> = preferences.defaults();
export const isPreference: PreferenceRegistry["validate"] = preferences.validate
  .bind(preferences);

export { registerDiffPreferences } from "./preferences/diff.ts";
export {
  registerLayoutPreferences,
  type ShellLayout,
} from "./preferences/layout.ts";
export { registerKeymapPreferences } from "./preferences/keymap.ts";
export { registerNotificationPreferences } from "./preferences/notifications.ts";
export { registerPromptPreferences } from "./preferences/prompt.ts";
export {
  MAX_FAVOURITE_MODELS,
  MAX_RECENT_MODELS,
  registerModelPreferences,
} from "./preferences/models.ts";
export { isThemeId, registerThemePreferences } from "./preferences/theme.ts";
export { registerTranscriptPreferences } from "./preferences/transcript.ts";
export { registerVisualPreferences } from "./preferences/visual.ts";
export {
  DEFAULT_PROJECT_AGEING,
  registerInboxPreferences,
} from "./preferences/inbox.ts";
