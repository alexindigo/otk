// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import {
  browserThemeEnvironment,
  CommandProvider,
  createUiRegistries,
  DialogHost,
  registerOtkThemes,
  registerTaskDialogs,
  ThemeEngine,
  ThemeRegistry,
  UiProvider,
} from "@otk/ui";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";

const commands = new CommandHub(), ui = createUiRegistries();
const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(themes, browserThemeEnvironment(), "otk-dark");
theme.start();
registerTaskDialogs(ui.dialogs);
const events: string[] = [],
  closes: (() => void)[] = [],
  inputs: (() => string)[] = [];
let finish: (() => void) | undefined;
ui.dialogs.register<{ name: string }>({
  id: "probe",
  title: (input) => input.name,
  dismiss: (input) => {
    events.push(`dismiss:${input.name}`);
  },
  component: (props) => {
    closes.push(props.close);
    inputs.push(() => props.input.name);
    const name = props.input.name;
    onSettled(() => {
      events.push(`mount:${name}`);
      return () => {
        events.push(`dispose:${name}`);
      };
    });
    return <p>{name}</p>;
  },
});

const driver = {
  events,
  closes,
  inputs,
  theme: (id: string) => theme.commit(id),
  finish: () => finish?.(),
  close: () => commands.run("dialog.close"),
  probe: (name: string) =>
    commands.run<{ close(): void }>("dialog.open", {
      id: "probe",
      input: { name },
    }),
  task: (name: string) =>
    commands.run<{ close(): void }>("dialog.open", {
      id: "task-name",
      input: {
        name,
        save: async (value: string) => {
          events.push(`save:${name}:${value}`);
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          events.push(`saved:${name}`);
        },
      },
    }),
};
declare global {
  var dialogTest: typeof driver;
}
globalThis.dialogTest = driver;
render(() => (
  <CommandProvider commands={commands}>
    <UiProvider registries={ui}>
      <h1>Dialog lifetime consumer</h1>
      <button type="button" id="origin">Opening control</button>
      <DialogHost />
    </UiProvider>
  </CommandProvider>
), document.getElementById("app")!);
