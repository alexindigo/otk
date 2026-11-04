// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { SidecarConnection } from "@otk/client";
import {
  browserThemeEnvironment,
  createUiRegistries,
  DeletedSession,
  paintVisualPreferences,
  PaneState,
  registerOtkThemes,
  ThemeEngine,
  ThemeRegistry,
  UiProvider,
} from "@otk/ui";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./scene.css" with { type: "text" };
const registry = new ThemeRegistry();
registerOtkThemes(registry);
const theme = new ThemeEngine(registry, browserThemeEnvironment(), "otk-dark");
theme.start();
const [ready, setReady] = createSignal(false);
const connection = new SidecarConnection(
  new URL(location.href).searchParams.get("server")!,
  {
    status() {},
    frame(frame) {
      if (frame.t === "prefs") {
        theme.commit(frame.prefs.theme, frame.prefs.systemLightTheme);
        paintVisualPreferences(frame.prefs);
        setReady(true);
      }
    },
  },
);
await connection.connect();
const states = [
  { id: "loading", kind: "pending" as const, text: "Loading messages" },
  {
    id: "reconnecting",
    kind: "connection" as const,
    text: "Reconnecting. Retaining loaded conversation",
  },
  {
    id: "error",
    kind: "error" as const,
    text: "Could not load this conversation",
  },
];
render(() => (
  <UiProvider registries={createUiRegistries()}>
    <main data-ready={String(ready())}>
      <header>
        Public component contracts - retained source is not a native failure
      </header>
      <div class="theme-panes">
        <For each={states}>
          {(state) => (
            <section data-pane={state.id} aria-label={state.text}>
              <div class="theme-pane-chrome">Conversation</div>
              <div
                class="theme-pane-body"
                aria-busy={state.id === "loading" ? "true" : "false"}
              >
                <PaneState
                  feedback={{ kind: state.kind, text: state.text }}
                />
                {state.id !== "loading" && (
                  <p class="theme-retained">
                    Retained source: const answer = 42;
                  </p>
                )}
              </div>
            </section>
          )}
        </For>
        <section data-pane="deleted">
          <div class="theme-pane-chrome">Retained session</div>
          <div class="theme-pane-body">
            <DeletedSession
              title="Deleted research session"
              notice="This session was deleted. Retained metadata is shown below."
              facts={[{ label: "Model calls", value: "Unknown" }]}
              retained={[{ owner: "prompt", value: "Keep my unsent source" }]}
              copy={() => {}}
            />
          </div>
        </section>
      </div>
    </main>
  </UiProvider>
), document.getElementById("app")!);
await document.fonts.ready;
