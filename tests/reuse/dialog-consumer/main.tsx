// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For, onSettled, Show } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub, SidecarConnection } from "@otk/client";
import {
  browserThemeEnvironment,
  CommandProvider,
  createUiRegistries,
  DialogHost,
  Palette,
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
const server = new URL(location.href).searchParams.get("server");
if (server) {
  const connection = new SidecarConnection(server, {
    status() {},
    frame(frame) {
      if (frame.t === "prefs") {
        theme.commit(frame.prefs.theme, frame.prefs.systemLightTheme);
      }
    },
  });
  await connection.connect();
}
registerTaskDialogs(ui.dialogs);
const events: string[] = [],
  closes: (() => void)[] = [],
  dismissCloses: (() => void)[] = [],
  inputs: (() => string)[] = [];
const [palette, setPalette] = createSignal(false);
const [available, setAvailable] = createSignal(true);
const [originGeneration, setOriginGeneration] = createSignal(0);
commands.register({
  id: "consumer.action",
  title: "Consumer action",
  category: "Consumer",
  enabled: available,
  run: () => events.push("action"),
});
let finish: (() => void) | undefined;
ui.dialogs.register<{ name: string }>({
  id: "probe",
  title: (input) => input.name,
  dismiss: (input, close?: () => void) => {
    events.push(`dismiss:${input.name}`);
    dismissCloses.push(() => close?.());
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
  dismissCloses,
  inputs,
  palette: () => setPalette(true),
  available: (value: boolean) => setAvailable(value),
  replaceOrigin: () => setOriginGeneration((value) => value + 1),
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
      <For each={[originGeneration()]} keyed={(value) => value}>
        {() => <button type="button" id="origin">Opening control</button>}
      </For>
      <DialogHost />
      <Show when={palette()}>
        <Palette
          onClose={() => {
            events.push("palette:closed");
            setPalette(false);
          }}
        />
      </Show>
    </UiProvider>
  </CommandProvider>
), document.getElementById("app")!);
