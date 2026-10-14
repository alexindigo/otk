// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import App from "./ui/App.tsx";
import { UiProvider } from "@otk/ui";
import { applicationUi } from "./features.ts";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
const registries = applicationUi();
render(() => (
  <UiProvider registries={registries}>
    <App />
  </UiProvider>
), document.getElementById("app")!);
