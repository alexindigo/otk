// SPDX-License-Identifier: LGPL-3.0-only
import "./Dialog.css" with { type: "text" };
import { type Element, onSettled } from "solid-js";
import { ownedCommand, useCommandPorts } from "../../keyboard/context.tsx";
import Surface from "./Surface.tsx";

export default function Dialog(props: {
  id: string;
  title: string;
  size?: "form" | "standard" | "editor";
  onClose(): void;
  children: Element;
}): Element {
  const ports = useCommandPorts();
  let dialog!: HTMLDialogElement;
  const close = ownedCommand(ports, {
    id: `${props.id}.close`,
    title: `Close ${props.title}`,
    category: "Dialogs",
    run: () => props.onClose(),
  });
  onSettled(() => {
    const prior = document.activeElement as HTMLElement | null;
    const originID = prior?.id;
    dialog.showModal();
    const release = ports.keyboard?.layer(`${props.id}.close`, () => true, 30);
    return () => {
      release?.();
      dialog.close();
      // Content publication can replace the opening control during the modal.
      const origin = originID
        ? document.getElementById(originID) ?? prior
        : prior;
      if (origin?.isConnected) origin.focus();
    };
  });
  return (
    <dialog
      class="otk-dialog"
      data-size={props.size ?? "standard"}
      data-dialog={props.id}
      aria-label={props.title}
      ref={(el) => {
        dialog = el;
      }}
      onCancel={(event) => {
        event.preventDefault();
        void close();
      }}
    >
      <Surface
        title={
          <>
            <h2>{props.title}</h2>
            <button
              type="button"
              onClick={() => void close()}
              aria-label={`Close ${props.title}`}
            >
              Close
            </button>
          </>
        }
      >
        {props.children}
      </Surface>
    </dialog>
  );
}
