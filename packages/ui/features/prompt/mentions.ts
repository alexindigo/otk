// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { editDraft, insertChip } from "../../components/prompt/model.ts";
import {
  mention,
  mentionOptions,
  mentionQuery,
} from "../../components/prompt/autocomplete.ts";
export function registerMentionsPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "mentions",
    create: (ctx) => ({
      source: {
        trigger: mention,
        options: async (token) =>
          mentionOptions(
            await ctx.props.onMentions(mentionQuery(token.query).query),
            token.query,
          ),
        select(token, option, expand) {
          if (expand && option.directory) {
            ctx.change((current) =>
              editDraft(
                current,
                current.input.slice(0, token.start) +
                  `@${option.path!.replace(/\/$/, "")}/` +
                  current.input.slice(token.end),
              ), token.start + option.path!.replace(/\/$/, "").length + 2);
            return;
          }
          if (option.part) {
            ctx.change((current) =>
              insertChip(
                current,
                token.start,
                token.end,
                `@${option.label}`,
                option.part!,
              ), token.start + option.label.length + 2);
            if (option.path) void ctx.props.onBump(option.path).catch(ctx.fail);
          }
          ctx.focus();
        },
      },
    }),
  });
}
