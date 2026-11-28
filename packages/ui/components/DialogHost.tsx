// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For, onCleanup } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import Dialog from "./surface/Dialog.tsx";

interface OpenDialog {
  id: string;
  input: unknown;
  origin?: HTMLElement;
}

/** A single owner for registered dialogs, including external feature dialogs. */
export default function DialogHost(
  props: { onChange?(id: string): void },
): import("solid-js").Element {
  const { dialogs } = useUiRegistries(), ports = useCommandPorts();
  const [opened, setOpened] = createSignal<OpenDialog>();
  const ended = new WeakSet<OpenDialog>();
  const end = (owner: OpenDialog) => {
    if (ended.has(owner)) return;
    ended.add(owner);
    dialogs.resolve(owner.id)?.ended?.(owner.input);
  };
  const replace = (next?: OpenDialog) => {
    const previous = opened();
    setOpened(next);
    props.onChange?.(next?.id ?? "");
    if (previous) end(previous);
  };
  const close = (owner = opened()) => {
    if (owner && opened() === owner && !ended.has(owner)) replace();
  };
  onCleanup(() => {
    const owner = opened();
    if (owner) end(owner);
  });
  ownedCommand(ports, {
    id: "dialog.open",
    title: "Open dialog",
    category: "Dialogs",
    arguments: { type: "object", properties: { id: { type: "string" } } },
    enabled: (_ctx, request?: { id: string; input?: unknown }) =>
      !request || !!dialogs.resolve(request.id),
    run: (_ctx, request: { id: string; input?: unknown }) => {
      if (!dialogs.resolve(request.id)) {
        throw new Error(`Unknown dialog: ${request.id}`);
      }
      const owner = {
        id: request.id,
        input: request.input,
        origin: opened()?.origin ??
          (document.activeElement as HTMLElement | null) ?? undefined,
      };
      replace(owner);
      return { close: () => close(owner) };
    },
  });
  ownedCommand(ports, {
    id: "dialog.close",
    title: "Close dialog",
    category: "Dialogs",
    run: () => close(),
  });
  return (
    <For each={opened() ? [opened()!] : []} keyed={(value) => value}>
      {(value) => {
        const owner = value(), definition = dialogs.resolve(owner.id)!;
        const dialogProps = { input: owner.input, close: () => close(owner) };
        return (
          <Dialog
            size={definition.size}
            id={definition.commandId ?? definition.id}
            origin={owner.origin}
            title={typeof definition.title === "function"
              ? definition.title(owner.input)
              : definition.title ?? definition.id}
            actions={definition.actions?.(dialogProps)}
            onClosed={dialogProps.close}
            onClose={() => {
              if (opened() !== owner) return;
              if (definition.dismiss) {
                definition.dismiss(owner.input, () => close(owner));
              } else close(owner);
            }}
          >
            {definition.component(dialogProps)}
          </Dialog>
        );
      }}
    </For>
  );
}
