// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { editDraft, editorSave } from "../../components/prompt/model.ts";
import Editor from "../../components/prompt/Editor.tsx";
export function registerEditorPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "editor",
    create: (ctx) => ({
      beforeSubmit(draft) {
        if (
          draft.mode !== "normal" || !/^\/editor(?:\s|$)/.test(draft.input)
        ) return false;
        ctx.change((current) => {
          if (current !== draft) return current;
          const edited = editDraft(
            current,
            current.input.replace(/^\/editor\s?/, ""),
          );
          return { ...edited, editor: { text: edited.input } };
        });
        return true;
      },
      actions: () => (
        <button
          type="button"
          onClick={() =>
            ctx.change((current) => ({
              ...current,
              editor: { text: current.input },
            }))}
        >
          Edit prompt
        </button>
      ),
      overlay: () => (
        <Show when={ctx.props.value.editor}>
          {(editor) => (
            <Editor
              title={editor().chipID ? "Edit pasted text" : "Edit prompt"}
              value={editor().text}
              onChange={(text) =>
                ctx.change((current) =>
                  current.editor
                    ? { ...current, editor: { ...current.editor, text } }
                    : current
                )}
              onSave={() => {
                ctx.change(editorSave);
                ctx.focus();
              }}
              onCancel={() => {
                ctx.change((current) => ({ ...current, editor: undefined }));
                ctx.focus();
              }}
            />
          )}
        </Show>
      ),
    }),
  });
}
