// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { editorSave } from "../../components/prompt/model.ts";
import Editor from "../../components/prompt/Editor.tsx";
import { ownedCommand } from "../../keyboard/context.tsx";
export function registerEditorPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "editor",
    create: (ctx) => {
      const open = ownedCommand(ctx, {
        id: "prompt.editor",
        title: "Edit prompt",
        category: "Prompt",
        slash: ["editor"],
        run: () => {
          ctx.change((current) => ({
            ...current,
            editor: { text: current.input },
          }));
        },
      });
      const save = ownedCommand(ctx, {
        id: "prompt.editor.save",
        title: "Save editor",
        category: "Prompt",
        hidden: true,
        run: () => {
          ctx.change(editorSave);
          ctx.focus();
        },
      });
      const cancel = ownedCommand(ctx, {
        id: "prompt.editor.cancel",
        title: "Cancel editor",
        category: "Prompt",
        hidden: true,
        run: () => {
          ctx.change((current) => ({ ...current, editor: undefined }));
          ctx.focus();
        },
      });
      ctx.own(
        ctx.keyboard.layer(
          "prompt.editor.cancel",
          () => !!ctx.props.value.editor,
          25,
        ),
      );
      return {
        actions: () => (
          <button
            type="button"
            onClick={() => void open().catch(ctx.fail)}
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
                onSave={() => void save().catch(ctx.fail)}
                onCancel={() => void cancel().catch(ctx.fail)}
              />
            )}
          </Show>
        ),
      };
    },
  });
}
