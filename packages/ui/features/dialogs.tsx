// SPDX-License-Identifier: LGPL-3.0-only
import Palette from "../components/Palette.tsx";
import KeysHelp from "../components/KeysHelp.tsx";
import ThemePicker from "../components/ThemePicker.tsx";
import ActionButton from "../components/ActionButton.tsx";
import { DisplayPreferences } from "../components/DisplayMenu.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import { useShellPorts } from "../shell/context.tsx";
import type { DialogRegistry } from "../registries/shell.ts";
import {
  type ActionControl,
  type CommandHub,
  LOCAL_SIDECAR,
} from "@otk/client";

interface Confirmation {
  message: string;
  resolve(accepted: boolean): void;
}

function dialogAction(run: () => void): ActionControl {
  return {
    availability: () => ({ available: true }),
    subscribe: () => () => {},
    run: () => {
      run();
      return Promise.resolve({ kind: "shown" });
    },
  };
}

export function confirmAction(
  commands: CommandHub,
  message: string,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  void commands.run("dialog.open", {
    id: "confirm-action",
    input: { message, resolve } satisfies Confirmation,
  }).catch(() => resolve(false));
  return promise;
}

export function registerCommandDialogs(dialogs: DialogRegistry): void {
  dialogs.register<Confirmation>({
    id: "confirm-action",
    title: "Confirm action",
    ended: (input) => input.resolve(false),
    component: ({ input }) => <p>{input.message}</p>,
    actions: ({ input, close }) => (
      <>
        <ActionButton class="otk-pill" action={dialogAction(close)}>
          Cancel
        </ActionButton>
        <ActionButton
          class="otk-primary otk-pill"
          action={dialogAction(() => {
            input.resolve(true);
            close();
          })}
        >
          Continue
        </ActionButton>
      </>
    ),
  });
  dialogs.register({
    id: "display",
    title: "Display preferences",
    component: () => {
      const shell = useShellPorts(), { commands } = useCommandPorts();
      return (
        <DisplayPreferences
          prefs={shell.toggles.state.prefs}
          ready={shell.toggles.state.ready}
          error={shell.toggles.state.error}
          onSet={(key, value) => commands.run("prefs.set", { key, value })}
        />
      );
    },
  });
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
