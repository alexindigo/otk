// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptRegistry } from "../../registries/prompt.ts";
import { editDraft, insertChip } from "../../components/prompt/model.ts";
import {
  mention,
  mentionOptions,
} from "../../components/prompt/autocomplete.ts";
export function registerMentionsPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "mentions",
    create: (ctx) => ({
      source: {
        trigger: mention,
        revision: () => [
          ctx.directoryCatalog?.state.catalog?.revision,
          ctx.frecencyCatalog?.revision,
        ],
        options: (token) => {
          const catalog = ctx.directoryCatalog?.state.catalog;
          return Promise.resolve(mentionOptions({
            files: catalog?.values.files?.value ?? [],
            agents: catalog?.values.agents?.value?.filter((agent) =>
              agent.mention
            ) ?? [],
            resources: catalog?.values.resources?.value ?? [],
            frecency: ctx.frecencyCatalog?.entries ?? [],
            scores: ctx.frecencyCatalog?.scores,
            directory: catalog?.directory ?? "",
            paths: catalog?.paths,
          }, token.query));
        },
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
            if (option.path) {
              void ctx.rpc("frecency.bump", {
                sessionID: ctx.sessionID(),
                path: option.path,
              }).catch(ctx.fail);
            }
          }
          ctx.focus();
        },
      },
    }),
  });
}
