// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import {
  commandOptions,
  parseCommand,
} from "../../components/prompt/autocomplete.ts";
import { editDraft } from "../../components/prompt/model.ts";
import type { PromptPart } from "@otk/protocol";
export function registerSlashPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "slash",
    create: (ctx) => ({
      source: {
        trigger(input, caret) {
          const before = input.slice(0, caret);
          return /^\/[^\s]*$/.test(before)
            ? { start: 0, end: caret, query: before.slice(1) }
            : undefined;
        },
        options: async (token) =>
          commandOptions(await ctx.props.onCommands(), token.query),
        select(token, option) {
          const command = option.command;
          if (!command) return;
          ctx.change((current) => {
            const next = editDraft(
              current,
              current.input.slice(0, token.start) +
                (command.source === "builtin" ? "" : `/${command.name} `) +
                current.input.slice(token.end),
            );
            return command.source === "builtin" && command.name === "editor"
              ? { ...next, editor: { text: next.input } }
              : next;
          }, command.source === "builtin" ? 0 : command.name.length + 2);
          if (command.source === "builtin" && command.name === "new") {
            void ctx.props.onNew().catch(ctx.fail);
          }
        },
      },
      async beforeSubmit(draft) {
        if (
          draft.mode !== "normal" ||
          parseCommand(draft.input)?.command !== "new"
        ) return false;
        ctx.change((current) =>
          current === draft
            ? editDraft(current, current.input.replace(/^\/new\s?/, ""))
            : current
        );
        try {
          await ctx.props.onNew();
        } catch (error) {
          ctx.fail(error);
        }
        return true;
      },
      async submit(draft, parts) {
        const parsed = draft.mode === "normal"
          ? parseCommand(draft.input)
          : undefined;
        const command = parsed &&
          (await ctx.props.onCommands()).find((command) =>
            command.name === parsed.command
          );
        if (!command) return false;
        await ctx.props.onCommand(
          command.name,
          parseCommand(parts.find((part) => part.kind === "text")!.text)!
            .arguments,
          parts.filter((part): part is Extract<PromptPart, { kind: "file" }> =>
            part.kind === "file"
          ),
        );
        return true;
      },
    }),
  });
}
