// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import {
  browserThemeEnvironment,
  CommandProvider,
  ContextMenu,
  contextTarget,
  createUiRegistries,
  DialogHost,
  DisplayMenu,
  ownedCommand,
  registerOtkThemes,
  ThemeEngine,
  ThemeRegistry,
  UiProvider,
} from "@otk/ui";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(themes, browserThemeEnvironment(), "otk-dark");
theme.start();
const commands = new CommandHub(), ui = createUiRegistries();
ui.dialogs.register({
  id: "context-probe",
  title: "Modal context probe",
  component: () => (
    <>
      <input id="modal-field" aria-label="Modal input" />
      <DisplayMenu
        prefs={DEFAULT_PREFS}
        ready
        error=""
        onSet={() => Promise.resolve()}
      />
    </>
  ),
});
function Consumer() {
  let root!: HTMLElement;
  const [name, setName] = createSignal("original"),
    [result, setResult] = createSignal("");
  const [allowed, setAllowed] = createSignal(true);
  const [menus, setMenus] = createSignal(true);
  ownedCommand({ commands }, {
    id: "probe.inner",
    title: "Inspect code",
    category: "Probe",
    hidden: true,
    context: { kind: "probe.code" },
    run: (_ctx, value: string) => {
      setResult(value);
    },
  });
  ownedCommand({ commands }, {
    id: "probe.outer",
    title: "Inspect reply",
    category: "Probe",
    hidden: true,
    context: {
      kind: "probe.reply",
      title: (value: string) => `Inspect ${value}`,
    },
    run: (_ctx, value: string) => {
      setResult(value);
    },
  });
  ownedCommand({ commands }, {
    id: "probe.close",
    title: "Close reply",
    category: "Probe",
    hidden: true,
    context: { kind: "probe.reply", destructive: true },
    enabled: () => allowed(),
    run: () => {
      setResult("closed");
    },
  });
  for (const kind of ["probe.third", "app"]) {
    onCleanup(
      commands.register({
        id: kind,
        title: kind,
        category: "Probe",
        context: { kind },
        run: () => {
          setResult(kind);
        },
      }),
    );
  }
  return (
    <main
      ref={(el) => {
        root = el;
      }}
    >
      <button type="button" id="rename" onClick={() => setName("changed")}>
        Change target data
      </button>
      <button type="button" id="disable" onClick={() => setAllowed(false)}>
        Remove close action
      </button>
      <button
        type="button"
        id="release-inner"
        onClick={() => commands.unregister("probe.inner")}
      >
        Release code owner
      </button>
      <button
        type="button"
        id="light"
        onClick={() => theme.commit("otk-light")}
      >
        Light
      </button>
      <button
        id="open-modal"
        type="button"
        onClick={() =>
          void commands.run("dialog.open", { id: "context-probe" })}
      >
        Open modal
      </button>
      <button
        id="remove-modal"
        type="button"
        onClick={() => void commands.run("dialog.close")}
      >
        Remove modal host
      </button>
      <button
        id="toggle-menus"
        type="button"
        onClick={() => setMenus(!menus())}
      >
        Toggle menu owner
      </button>
      <section
        ref={contextTarget(() => ({ kind: "probe.third", data: "third" }))}
      >
        <article
          ref={contextTarget(() => ({ kind: "probe.reply", data: name() }))}
        >
          <button
            id="inner"
            type="button"
            ref={[
              (element: HTMLElement) => {
                element.dataset.composedRef = "yes";
              },
              contextTarget(() => ({
                kind: "probe.code",
                data: `code:${name()}`,
              })),
            ]}
          >
            Nested context target
          </button>
        </article>
      </section>
      <p id="result">{result()}</p>
      <img
        id="no-viewer"
        alt="Unregistered viewer probe"
        width="40"
        height="40"
        src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="orange"/></svg>'
      />
      <Show when={menus()}>
        <ContextMenu root={root} />
      </Show>
      <DialogHost />
    </main>
  );
}
render(() => (
  <UiProvider registries={ui}>
    <CommandProvider commands={commands}>
      <Consumer />
    </CommandProvider>
  </UiProvider>
), document.getElementById("app")!);
