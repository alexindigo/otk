// SPDX-License-Identifier: LGPL-3.0-only
import "./Editor.css" with { type: "text" };
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
  const cancel = ownedAction("editor.cancel", () => props.onCancel());
  const save = ownedAction("editor.save", () => props.onSave());
  return (
    <div class="otk-editor">
      <p>Save to keep changes · Esc to cancel</p>
      <textarea
        autofocus
        name="editor"
        aria-label="Editor text"
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
      <footer>
        <button type="button" onClick={() => void cancel()}>Cancel</button>
        <button type="button" onClick={() => void save()}>Save</button>
      </footer>
    </div>
  );
}
