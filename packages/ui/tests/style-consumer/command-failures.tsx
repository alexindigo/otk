// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { type CommandDefinition, CommandHub } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import { CommandProvider } from "../../keyboard/context.tsx";
import Palette from "../../components/Palette.tsx";
import CommandMenu from "../../components/CommandMenu.tsx";
import MessageFooter from "../../components/MessageFooter.tsx";
import Toasts from "../../components/Toasts.tsx";
import { applicationNotifications } from "../../shell/notifications.ts";

/** Real failure consumers, with only the command's outcome held by the fixture. */
export default function CommandFailures() {
  const surface = new URL(location.href).searchParams.get("surface");
  const commands = new CommandHub();
  const id = surface === "message" ? "reply.copy" : "consumer.private-copy";
  const [started, setStarted] = createSignal(false);
  const [replaced, setReplaced] = createSignal(false);
  let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const register = (replacement: boolean) => {
    const command: CommandDefinition = {
      id,
      title: replacement ? "Replacement command" : "Original command",
      category: "Consumer",
      arguments: { type: "object", optional: true },
      context: {
        kind: "reply",
        items: () => [{
          key: "copy",
          title: replacement
            ? "Replacement projected action"
            : "Original projected action",
          args: undefined,
        }],
      },
      run() {
        pending = Promise.withResolvers<void>();
        setStarted(true);
        return pending.promise;
      },
    };
    commands.register(command);
  };
  register(false);
  const notifications = applicationNotifications({
    commands,
    prefs: () => DEFAULT_PREFS,
    selection: () => undefined,
    viewing: () => false,
    entry: () => undefined,
    observeEntries: () => () => {},
    connection: () => {
      throw new Error("No connection expected");
    },
    entities: () => {
      throw new Error("No attention expected");
    },
  });
  onCleanup(() => notifications.stop());
  onSettled(() => {
    if (surface !== "notification") return;
    notifications.hub.publish({
      id: "consumer-note",
      kind: "info",
      title: "Original notification",
      actions: [{ label: "Original notification action", command: id }],
    });
  });
  return (
    <CommandProvider commands={commands}>
      <header>
        <button
          type="button"
          data-replace
          onClick={() => {
            commands.unregister(id);
            register(true);
            setReplaced(true);
          }}
        >
          Replace command owner
        </button>
        <button
          type="button"
          data-reject
          onClick={() =>
            pending?.reject(new Error("Private command diagnostic"))}
        >
          Reject original invocation
        </button>
        <output data-started>{String(started())}</output>
        <output data-replaced>{String(replaced())}</output>
      </header>
      <section data-command-surface>
        <Show when={surface === "palette"}>
          <Palette
            onClose={() => {
              throw new Error("Failed command closed palette");
            }}
          />
        </Show>
        <Show when={surface === "menu"}>
          <CommandMenu
            label="Open command menu"
            trigger="Open command menu"
            targets={() => [{ kind: "reply", data: undefined }]}
          />
        </Show>
        <Show when={surface === "message"}>
          <MessageFooter
            actions={{
              kind: "reply",
              target: { sessionID: "tstv1-captured", label: "Captured target" },
            }}
          />
        </Show>
        <Show when={surface === "notification"}>
          <Toasts model={notifications.toast} onMore={() => {}} />
        </Show>
      </section>
    </CommandProvider>
  );
}
