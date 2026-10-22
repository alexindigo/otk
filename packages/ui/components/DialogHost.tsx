// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import Dialog from "./surface/Dialog.tsx";

/** A single owner for registered dialogs, including external feature dialogs. */
export default function DialogHost(
  props: { onChange?(id: string): void },
): import("solid-js").Element {
  const { dialogs } = useUiRegistries(), ports = useCommandPorts();
  const [opened, setOpened] = createSignal<{ id: string; input: unknown }>();
  const close = (owner = opened()) => {
    if (opened() !== owner) return;
    setOpened(undefined);
    props.onChange?.("");
  };
  ownedCommand(ports, {
    id: "dialog.open",
    title: "Open dialog",
    category: "Dialogs",
    hidden: true,
    enabled: (_ctx, request?: { id: string; input?: unknown }) =>
      !request || !!dialogs.resolve(request.id),
    run: (_ctx, request: { id: string; input?: unknown }) => {
      if (!dialogs.resolve(request.id)) {
        throw new Error(`Unknown dialog: ${request.id}`);
      }
      const owner = { id: request.id, input: request.input };
      setOpened(owner);
      props.onChange?.(request.id);
      return { close: () => close(owner) };
    },
  });
  ownedCommand(ports, {
    id: "dialog.close",
    title: "Close dialog",
    category: "Dialogs",
    hidden: true,
    run: () => close(),
  });
  return (
    <For each={opened() ? [opened()!] : []} keyed={(value) => value}>
      {(value) => {
        const owner = value(), definition = dialogs.resolve(owner.id)!;
        return (
          <Dialog
            id={definition.commandId ?? definition.id}
            title={typeof definition.title === "function"
              ? definition.title(owner.input)
              : definition.title ?? definition.id}
            onClose={() => {
              if (opened() !== owner) return;
              if (definition.dismiss) definition.dismiss(owner.input);
              else close(owner);
            }}
          >
            {definition.component({
              input: owner.input,
              close: () => close(owner),
            })}
          </Dialog>
        );
      }}
    </For>
  );
}
