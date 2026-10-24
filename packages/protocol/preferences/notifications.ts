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
    settings: { group: "notifications", order: 0, control: { kind: "toggle" } },
  });
  registry.register({
    key: "notify.os",
    default: false,
    validate: booleanPreference,
    label: "Browser notifications",
    settings: { group: "notifications", order: 1, control: { kind: "toggle" } },
  });
  registry.register({
    key: "notify.sound",
    default: false,
    validate: booleanPreference,
    label: "Sound",
    settings: { group: "notifications", order: 2, control: { kind: "toggle" } },
  });
  registry.register({
    key: "notify.badge",
    default: true,
    validate: booleanPreference,
    label: "Favicon attention badge",
    settings: { group: "notifications", order: 3, control: { kind: "toggle" } },
  });
}
