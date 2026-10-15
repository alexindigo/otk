// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub } from "@otk/client";
import {
  type PreferenceKey,
  type PreferenceRegistry,
  type Preferences,
  preferences,
} from "@otk/protocol";
export function registerPreferenceCommands(commands: CommandHub, actions: {
  ready(): boolean;
  prefs(): Preferences;
  set(key: PreferenceKey, value: Preferences[PreferenceKey]): Promise<void>;
}, registry: PreferenceRegistry = preferences): () => void {
  const releases = [commands.register({
    id: "prefs.set",
    title: "Set preference",
    category: "Display",
    hidden: true,
    run: (
      _ctx,
      input: { key: PreferenceKey; value: Preferences[PreferenceKey] },
    ) => actions.set(input.key, input.value),
  })];
  for (const definition of registry.display()) {
    const { key, label, display } = definition, control = display!.control;
    const action = control.kind === "toggle" || control.options.length === 2
      ? "toggle"
      : "cycle";
    releases.push(
      commands.register({
        id: `prefs.${action}.${key}`,
        title: `${
          action === "toggle" ? "Toggle" : "Cycle"
        } ${label.toLowerCase()}`,
        category: "Display",
        enabled: actions.ready,
        run: () => {
          const current = actions.prefs()[key];
          return actions.set(
            key,
            control.kind === "toggle" ? !current : control.options[
              (control.options.findIndex((option) => option.value === current) +
                1) % control.options.length
            ].value,
          );
        },
      }),
    );
  }
  return () => releases.forEach((release) => release());
}
