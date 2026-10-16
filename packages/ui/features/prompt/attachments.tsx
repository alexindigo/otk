// SPDX-License-Identifier: LGPL-3.0-only
import { onSettled } from "solid-js";
import type { PromptRegistry } from "../../registries/prompt.ts";
import {
  type Chip,
  editDraft,
  insertChip,
} from "../../components/prompt/model.ts";
import { upload } from "../../components/prompt/attachments.ts";
import Chips from "../../components/prompt/Chips.tsx";
import { AttachIcon } from "../../components/ChromeIcons.tsx";
export function registerAttachmentsPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "attachments",
    create: (ctx) => {
      let picker!: HTMLInputElement;
      onSettled(() => () => {
        picker.value = "";
      });
      return {
        actions: () => (
          <>
            <input
              ref={(element) => {
                picker = element;
              }}
              type="file"
              multiple
              hidden
              aria-label="Attachments"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                void ctx.acceptFiles(files).catch(ctx.fail);
              }}
            />
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              class="otk-icon-button"
              onClick={() => picker.click()}
            >
              <AttachIcon />
            </button>
          </>
        ),
        beforeInput: () => (
          <Chips
            chips={ctx.props.value.chips}
            onOpen={(chip) =>
              chip.part.kind === "text"
                ? ctx.change((current) => {
                  const found = current.chips.find((value) =>
                    value.id === chip.id
                  );
                  return found?.part.kind === "text"
                    ? {
                      ...current,
                      editor: { chipID: found.id, text: found.part.text },
                    }
                    : current;
                })
                : ctx.focus()}
            onRemove={(chip) =>
              ctx.change((current) => {
                const found = current.chips.find((item) => item.id === chip.id);
                return found
                  ? editDraft(
                    current,
                    current.input.slice(0, found.start) +
                      current.input.slice(found.end),
                  )
                  : current;
              })}
          />
        ),
        async drop(items) {
          if (!items.length) return;
          const uploads: { file: File; id: string }[] = [];
          let { start: caret } = ctx.selection();
          const { end } = ctx.selection();
          ctx.change((current) => {
            let draft = current;
            for (const [index, file] of items.entries()) {
              const label = file.type === "application/pdf"
                ? "PDF"
                : file.type.startsWith("image/")
                ? "Image"
                : "File";
              const count = draft.chips.filter((chip) =>
                chip.label.startsWith(`[${label} `)
              ).length + 1;
              const before = new Set(draft.chips.map((chip) =>
                chip.id
              ));
              draft = insertChip(
                draft,
                caret,
                index ? caret : end,
                `[${label} ${count}]`,
                {
                  kind: "file",
                  source: "upload",
                  name: file.name,
                  mime: file.type || "application/octet-stream",
                  dataBase64: "",
                },
              );
              const chip = draft.chips.find((chip) => !before.has(chip.id))!;
              draft = {
                ...draft,
                chips: draft.chips.map((item) =>
                  item.id === chip.id ? { ...item, pending: true } : item
                ),
              };
              uploads.push({ file, id: chip.id });
              caret = chip.end + 1;
            }
            return draft;
          });
          ctx.change((current) => current, caret);
          for (const { file, id } of uploads) {
            const patch = (value: Partial<Chip>) =>
              ctx.change((current) =>
                current.chips.some((chip) => chip.id === id)
                  ? {
                    ...current,
                    chips: current.chips.map((chip) =>
                      chip.id === id ? { ...chip, ...value } : chip
                    ),
                  }
                  : current
              );
            try {
              const part = await upload(file);
              patch({ part, pending: false });
            } catch (error) {
              patch({ pending: false, error: (error as Error).message });
            }
          }
        },
      };
    },
  });
}
