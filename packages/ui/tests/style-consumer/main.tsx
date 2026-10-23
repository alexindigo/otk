// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import { CommandProvider } from "../../keyboard/context.tsx";
import { createUiRegistries, UiProvider } from "../../registries/context.tsx";
import { ThemeRegistry } from "../../theme/registry.ts";
import { browserThemeEnvironment, ThemeEngine } from "../../theme/engine.ts";
import { registerOtkThemes } from "../../features/theme/otk.ts";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./scene.css" with { type: "text" };

const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(themes, browserThemeEnvironment(), "otk-dark");
theme.start();
const driver = {
  theme: (id: string) => theme.commit(id),
  reserve: (_value: boolean) => {},
  collapse: (_value: boolean) => {},
  conceal: (_value: boolean) => {},
};
declare global {
  var styleTest: typeof driver;
}
globalThis.styleTest = driver;
const scenes = {
  prose: () => import("./prose.tsx"),
  journal: () => import("./journal.tsx"),
  siblings: () => import("./siblings.tsx"),
  chrome: () => import("./chrome.tsx"),
};
const name = new URL(location.href).searchParams.get(
  "scene",
) as keyof typeof scenes;
const { default: Scene } = await scenes[name]();
render(() => (
  <CommandProvider commands={new CommandHub()}>
    <UiProvider registries={createUiRegistries()}>
      <main class="style-scene">
        <h1>Component style boundaries</h1>
        <Scene />
      </main>
    </UiProvider>
  </CommandProvider>
), document.getElementById("app")!);
await document.fonts.ready;
document.documentElement.dataset.ready = "true";
