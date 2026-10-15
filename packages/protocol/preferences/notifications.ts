// SPDX-License-Identifier: LGPL-3.0-only
import { booleanPreference, type PreferenceRegistry } from "../prefs.ts";
export interface NotificationPreferences {
  "notify.toast": boolean;
  "notify.os": boolean;
  "notify.sound": boolean;
  "notify.badge": boolean;
}
export function registerNotificationPreferences(
  registry: PreferenceRegistry,
): void {
  registry.register({
    key: "notify.toast",
    default: true,
    validate: booleanPreference,
    label: "In-page messages",
  });
  registry.register({
    key: "notify.os",
    default: false,
    validate: booleanPreference,
    label: "Browser notifications",
  });
  registry.register({
    key: "notify.sound",
    default: false,
    validate: booleanPreference,
    label: "Sound",
  });
  registry.register({
    key: "notify.badge",
    default: true,
    validate: booleanPreference,
    label: "Favicon attention badge",
  });
}
