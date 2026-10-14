// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub } from "@otk/client";
import type { PreferenceKey, Preferences } from "@otk/protocol";
export function registerPreferenceCommands(commands: CommandHub, actions: {
  ready(): boolean;
  prefs(): Preferences;
  set(key: PreferenceKey, value: Preferences[PreferenceKey]): Promise<void>;
}): () => void {
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
  for (
    const [key, title] of [
      ["timestamps", "Always show timestamps"],
      ["toolDetails", "Tool details"],
      ["conceal", "Conceal markup"],
      ["genericToolOutput", "Generic tool output"],
      ["diffWrap", "Wrap diffs"],
      ["scrollbar", "Scrollbar"],
      ["pasteSummary", "Paste summaries"],
    ] as const
  ) {
    releases.push(
      commands.register({
        id: `prefs.toggle.${key}`,
        title: `Toggle ${title.toLowerCase()}`,
        category: "Display",
        enabled: actions.ready,
        run: () => actions.set(key, !actions.prefs()[key]),
      }),
    );
  }
  releases.push(commands.register({
    id: "prefs.toggle.thinking",
    title: "Toggle thinking",
    category: "Display",
    enabled: actions.ready,
    run: () =>
      actions.set(
        "thinking",
        actions.prefs().thinking === "show" ? "hide" : "show",
      ),
  }));
  releases.push(commands.register({
    id: "prefs.cycle.diffStyle",
    title: "Cycle diff style",
    category: "Display",
    enabled: actions.ready,
    run: () =>
      actions.set(
        "diffStyle",
        ({ auto: "split", split: "unified", unified: "auto" } as const)[
          actions.prefs().diffStyle
        ],
      ),
  }));
  return () => releases.forEach((release) => release());
}
