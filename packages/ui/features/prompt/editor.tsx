// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, onSettled } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { editorSave } from "../../components/prompt/model.ts";
import Editor from "../../components/prompt/Editor.tsx";
import { ownedCommand } from "../../keyboard/context.tsx";
import type { DialogRegistry } from "../../registries/shell.ts";
export function registerEditorDialog(dialogs: DialogRegistry): void {
  dialogs.register<Parameters<typeof Editor>[0]>({
    id: "editor",
    title: (input) => input.title,
    commandId: "editor",
    dismiss: (input) => input.onCancel(),
    component: (props) => <Editor {...props.input} />,
  });
}
export function registerEditorPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "editor",
    create: (ctx) => {
      let dialog: { close(): void } | undefined;
      ctx.own(() => dialog?.close());
      const open = ownedCommand(ctx, {
        id: "prompt.editor",
        title: "Edit prompt",
        category: "Prompt",
        slash: ["editor"],
        enabled: () => !ctx.props.suspended,
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
          dialog?.close();
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
          dialog?.close();
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
      onSettled(() => {
        createEffect(() => !!ctx.props.value.editor, (opened) => {
          if (opened) {
            void ctx.commands.run<{ close(): void }>("dialog.open", {
              id: "editor",
              input: {
                get title() {
                  return ctx.props.value.editor?.chipID
                    ? "Edit pasted text"
                    : "Edit prompt";
                },
                get value() {
                  return ctx.props.value.editor?.text ?? "";
                },
                onChange: (text: string) =>
                  ctx.change((current) =>
                    current.editor
                      ? { ...current, editor: { ...current.editor, text } }
                      : current
                  ),
                onSave: () => {
                  void save().catch(ctx.fail);
                },
                onCancel: () => {
                  void cancel().catch(ctx.fail);
                },
              },
            }).then((handle) => {
              if (ctx.active()) dialog = handle;
              else handle.close();
            }).catch(ctx.fail);
          }
        });
      });
      return {
        actions: () => (
          <button
            type="button"
            aria-label="Edit prompt"
            onClick={() => void open().catch(ctx.fail)}
          >
            Edit prompt
          </button>
        ),
      };
    },
  });
}
