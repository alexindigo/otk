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
  engine: theme,
  theme: (id: string) => theme.commit(id),
  reserve: (_value: boolean) => {},
  collapse: (_value: boolean) => {},
  conceal: (_value: boolean) => {},
  lists: (_members: string[], _selected?: string, _editing?: string) => {},
  menuItems: (_keys: string[]) => {},
  feedback: (_state: "clear" | "pending" | "error") => {},
  holdMenu: (_value: boolean) => {},
  settleMenu: (_failed: boolean) => {},
  fieldFailure: (_name: string) => {},
  feedbackOwner: (_index: number) => {},
  mountFeedback: (_value: boolean) => {},
  emitFeedback: (
    _index: number,
    _kind: "pending" | "connection" | "error",
  ) => {},
  settlePreference: () => {},
  resetNotice: () => {},
  settleNotice: () => {},
  refreshNotice: () => {},
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
  lists: () => import("./lists.tsx"),
  requests: () => import("./requests.tsx"),
  forms: () => import("./forms.tsx"),
  "feedback-owners": () => import("./feedback-owners.tsx"),
  "preference-feedback": () => import("./preference-feedback.tsx"),
  "notice-lifetime": () => import("./notice-lifetime.tsx"),
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
