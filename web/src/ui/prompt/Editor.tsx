// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled } from "solid-js";
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
        props.onCancel();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
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
        <button type="button" onClick={props.onCancel}>Cancel</button>
        <button type="button" onClick={props.onSave}>Save</button>
      </footer>
    </dialog>
  );
}
