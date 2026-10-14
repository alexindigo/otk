// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { serverPath } from "../../components/prompt/attachments.ts";
import {
  editDraft,
  insertChip,
  pasteLabel,
} from "../../components/prompt/model.ts";
import { summarizePaste } from "../../components/prompt/paste.ts";
export function registerPastePrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "paste",
    create: (ctx) => ({
      async paste(event) {
        const data = event.clipboardData;
        if (!data) return;
        event.preventDefault();
        if (data.files.length) return ctx.acceptFiles(Array.from(data.files));
        const text = data.getData("text/plain").replace(/\r\n?/g, "\n"),
          { start, end } = ctx.selection();
        const summarized = summarizePaste(text, ctx.props.pasteSummary);
        const draft = ctx.change(
          (current) =>
            summarized
              ? insertChip(current, start, end, pasteLabel(text.trim()), {
                kind: "text",
                text: text.trim(),
              })
              : editDraft(
                current,
                current.input.slice(0, start) + text + current.input.slice(end),
              ),
          start +
            (summarized ? pasteLabel(text.trim()).length + 1 : text.length),
        );
        try {
          const path = serverPath(text),
            matches = path ? await ctx.props.onFind(path) : [];
          if (!ctx.active()) return;
          if (path && matches.some((file) => file.path === path)) {
            ctx.change(
              (current) =>
                current === draft
                  ? insertChip(
                    current,
                    start,
                    start + text.length,
                    `@${path}`,
                    {
                      kind: "file",
                      source: "path",
                      path,
                    },
                  )
                  : current,
              start + path.length + 2,
            );
          }
        } catch (error) {
          if (ctx.active() && ctx.change((current) => current) === draft) {
            ctx.fail(error);
          }
        }
      },
    }),
  });
}
