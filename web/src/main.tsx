// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import App from "./ui/App.tsx";
import { UiProvider } from "@otk/ui";
import { DEFAULT_PREFS } from "@otk/protocol";
import { applicationTheme, applicationUi } from "./features.ts";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
const registries = applicationUi();
const theme = applicationTheme(DEFAULT_PREFS.theme);
theme.start();
render(() => (
  <UiProvider registries={registries}>
    <App theme={theme} />
  </UiProvider>
), document.getElementById("app")!);
