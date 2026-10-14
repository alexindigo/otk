// SPDX-License-Identifier: LGPL-3.0-only
import "./CommandDialog.css" with { type: "text" };
import { type Element, onSettled } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
export default function CommandDialog(props: {
  id: string;
  title: string;
  onClose(): void;
  children: Element;
}): Element {
  const ports = useCommandPorts();
  let dialog!: HTMLDialogElement;
  const close = ownedCommand(ports, {
    id: `${props.id}.close`,
    title: `Close ${props.title}`,
    category: "Dialogs",
    hidden: true,
    run: () => props.onClose(),
  });
  onSettled(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const release = ports.keyboard?.layer(`${props.id}.close`, () => true, 30);
    return () => {
      release?.();
      dialog.close();
      if (prior?.isConnected) prior.focus();
    };
  });
  return (
    <dialog
      class="otk-command-dialog"
      aria-label={props.title}
      ref={(el) => {
        dialog = el;
      }}
      onCancel={(event) => {
        event.preventDefault();
        void close();
      }}
    >
      <header>
        <h2>{props.title}</h2>
        <button
          type="button"
          onClick={() => void close()}
          aria-label={`Close ${props.title}`}
        >
          Esc · Close
        </button>
      </header>
      {props.children}
    </dialog>
  );
}
