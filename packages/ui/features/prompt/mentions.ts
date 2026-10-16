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
        options: async (token) => {
          const sessionID = ctx.sessionID(),
            query = mentionQuery(token.query).query;
          const [files, agents, resources, frecency, directory] = await Promise
            .all([
              ctx.supports("files")
                ? ctx.rpc("find.files", { sessionID, query })
                : [],
              ctx.supports("agents")
                ? ctx.rpc("agents.list", { sessionID })
                : [],
              ctx.supports("resources")
                ? ctx.rpc("resources.list", { sessionID })
                : [],
              ctx.rpc("frecency.list", { sessionID }),
              ctx.directory(),
            ]);
          return mentionOptions({
            files,
            agents,
            resources,
            frecency,
            directory,
          }, token.query);
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
