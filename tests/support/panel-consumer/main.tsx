// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import { Shell, UiProvider, useShellPorts } from "@otk/ui";
import { applicationTheme, applicationUi } from "../../../web/src/features.ts";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
const ui = applicationUi(), theme = applicationTheme("otk-dark");
theme.start();
ui.panels.register({
  id: "external-view",
  title: "External view",
  icon: "◇",
  component: () => {
    const shell = useShellPorts();
    return (
      <p data-external-view>{shell.project()?.directory ?? "No project"}</p>
    );
  },
});
ui.panels.register({
  id: "unavailable",
  title: "Unavailable view",
  icon: "?",
  capability: "resources",
  component: () => <p data-unavailable>Should be hidden</p>,
});
render(() => (
  <UiProvider registries={ui}>
    <Shell theme={theme} api={new URL("/api/", location.href)} />
  </UiProvider>
), document.getElementById("app")!);
