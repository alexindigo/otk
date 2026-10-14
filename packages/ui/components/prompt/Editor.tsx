// SPDX-License-Identifier: LGPL-3.0-only
import "./Editor.css" with { type: "text" };
import { onSettled } from "solid-js";
import { ownedAction } from "../../keyboard/context.tsx";
export default function Editor(
  props: {
    value: string;
    title: string;
    onChange(value: string): void;
    onSave(): void;
    onCancel(): void;
  },
) {
  let dialog!: HTMLDialogElement, input!: HTMLTextAreaElement;
  const cancel = ownedAction("editor.cancel", () => props.onCancel());
  const save = ownedAction("editor.save", () => props.onSave());
  onSettled(() => {
    dialog.showModal();
    input.focus();
    return () => dialog.close();
  });
  return (
    <dialog
      class="otk-editor"
      ref={(el) => {
        dialog = el;
      }}
      aria-label={props.title}
      onCancel={(event) => {
        event.preventDefault();
        void cancel();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          void cancel();
        }
      }}
    >
      <header>
        <h2>{props.title}</h2>
        <span>Save to keep changes · Esc to cancel</span>
      </header>
      <textarea
        ref={(el) => {
          input = el;
        }}
        name="editor"
        aria-label="Editor text"
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
      <footer>
        <button type="button" onClick={() => void cancel()}>Cancel</button>
        <button type="button" onClick={() => void save()}>Save</button>
      </footer>
    </dialog>
  );
}
