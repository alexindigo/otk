// SPDX-License-Identifier: LGPL-3.0-only
import Palette from "../components/Palette.tsx";
import KeysHelp from "../components/KeysHelp.tsx";
import ThemePicker from "../components/ThemePicker.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import { useShellPorts } from "../shell/context.tsx";
import type { DialogRegistry } from "../registries/shell.ts";
import { LOCAL_SIDECAR } from "@otk/client";
export function registerCommandDialogs(dialogs: DialogRegistry): void {
  dialogs.register({
    id: "palette",
    title: "Commands",
    component: (props) => <Palette onClose={props.close} />,
  });
  dialogs.register({
    id: "keys",
    title: "Keyboard shortcuts",
    commandId: "help.keys",
    component: (props) => {
      const shell = useShellPorts(), { keyboard } = useCommandPorts();
      return (
        <KeysHelp
          keymap={keyboard!.keymap}
          ready={shell.toggles.state.ready}
          onSave={async (value) => {
            await shell.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
              key: "keymap",
              value,
            });
          }}
          onClose={props.close}
        />
      );
    },
  });
  dialogs.register({
    id: "theme",
    title: "Theme",
    commandId: "theme.picker",
    component: (props) => {
      const shell = useShellPorts();
      return (
        <ThemePicker
          theme={shell.theme}
          ready={shell.toggles.state.ready}
          systemLightTheme={shell.toggles.state.prefs.systemLightTheme}
          onSystemLightSave={async (value) => {
            await shell.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
              key: "systemLightTheme",
              value,
            });
          }}
          onSave={async (value) => {
            await shell.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
              key: "theme",
              value,
            });
          }}
          onClose={props.close}
        />
      );
    },
  });
}
