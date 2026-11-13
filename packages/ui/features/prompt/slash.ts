// SPDX-License-Identifier: LGPL-3.0-only
import type {
  PromptChoices,
  PromptContext,
  PromptRegistry,
} from "../../registries/prompt.ts";
import { createSignal } from "solid-js";
import { createHarnessCommands } from "@otk/client";
import {
  commandOptions,
  parseCommand,
} from "../../components/prompt/autocomplete.ts";
import { editDraft } from "../../components/prompt/model.ts";
import type { CommandOption, PromptPart, SkillOption } from "@otk/protocol";
/** Shared native submission path for catalog commands and explicit skill selections. */
export function submitPromptCommand(
  ctx: PromptContext,
  command: CommandOption,
  args: {
    arguments?: string;
    selection?: PromptChoices;
    parts?: Extract<PromptPart, { kind: "file" }>[];
    skill?: SkillOption;
  } = {},
) {
  return ctx.submit(async (options) => {
    if (!args.selection) await ctx.ready();
    const selection = args.selection ??
      ctx.nextSelection(ctx.change((draft) => draft)).input;
    await ctx.rpc("session.command", {
      sessionID: ctx.sessionID(),
      command: command.name,
      ...(args.skill
        ? {
          skill: {
            name: args.skill.name,
            ...(args.skill.id ? { id: args.skill.id } : {}),
          },
        }
        : {}),
      arguments: args.arguments ?? "",
      ...selection,
      parts: (await ctx.attachments(args.parts ?? [])).filter((
        part,
      ): part is Extract<PromptPart, { kind: "file" }> => part.kind === "file"),
    }, options);
  });
}
export function registerSlashPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "slash",
    create: (ctx) => {
      const [revision, setRevision] = createSignal(0);
      ctx.mount(() =>
        ctx.commands.subscribe(() => setRevision((value) => value + 1))
      );
      const owner = createHarnessCommands(ctx.commands, {
        available: () =>
          ctx.active() && !ctx.props.suspended && ctx.props.connected &&
          ctx.supports("commands"),
        execute: (command, args) => submitPromptCommand(ctx, command, args),
      });
      ctx.own(owner.dispose);
      let mounted = false;
      // CM3 adds disabled-row paint. The registry inventory itself is complete.
      const options = () =>
        ctx.commands.list().filter((row) => row.enabled).map(({ cmd }) => ({
          name: ctx.commands.spelling(cmd.id),
          description: cmd.description ?? cmd.title,
          aliases: [...cmd.aliases ?? [], cmd.id],
          source: cmd.source ?? "builtin" as const,
        }));
      const catalog = () => {
        if (!mounted) return options();
        if (!ctx.props.connected || !ctx.supports("commands")) {
          return options();
        }
        const values = ctx.directoryCatalog?.state.catalog?.values;
        if (!ctx.active()) return [];
        owner.update(values?.commands?.value ?? []);
        return options();
      };
      ctx.mount(() => {
        mounted = true;
        catalog();
        const stop = ctx.directoryCatalog?.subscribe(() => {
          catalog();
        });
        return () => {
          mounted = false;
          stop?.();
        };
      });
      return {
        async ready() {
          await ctx.directoryCatalog?.ready("commands");
          await ctx.directoryCatalog?.ready("skills");
          catalog();
        },
        source: {
          revision: () =>
            `${revision()}:${
              ctx.directoryCatalog?.state.catalog?.revision ?? ""
            }`,
          trigger(input, caret) {
            const before = input.slice(0, caret);
            return /^\/[^\s]*$/.test(before)
              ? { start: 0, end: caret, query: before.slice(1) }
              : undefined;
          },
          options: (token) =>
            Promise.resolve(commandOptions(options(), token.query)),
          select(token, option) {
            const command = option.command;
            if (!command) return;
            const id = ctx.commands.resolveSlash(command.name);
            const metadata = id ? ctx.commands.metadata(id) : undefined;
            const takesArguments = metadata?.kind === "submission" ||
              (metadata?.arguments?.type !== "none" &&
                !metadata?.arguments?.optional);
            ctx.change((current) => {
              const next = editDraft(
                current,
                current.input.slice(0, token.start) +
                  (takesArguments ? `/${command.name} ` : "") +
                  current.input.slice(token.end),
              );
              return next;
            }, takesArguments ? command.name.length + 2 : 0);
            if (!takesArguments) {
              if (id) void ctx.commands.run(id).catch(ctx.fail);
            }
          },
        },
        async beforeSubmit(draft) {
          const parsed = draft.mode === "normal"
            ? parseCommand(draft.input)
            : undefined;
          if (!parsed) return false;
          let invocation;
          try {
            invocation = ctx.commands.parse(parsed.command, parsed.arguments);
          } catch (error) {
            ctx.fail(error);
            return true;
          }
          if (!invocation) return false;
          if (ctx.commands.metadata(invocation.id)?.kind === "submission") {
            return false;
          }
          const prepared = ctx.change((current) =>
            current === draft
              ? editDraft(
                current,
                current.input.slice(parsed.command.length + 1).replace(
                  /^\s/,
                  "",
                ),
              )
              : current
          );
          try {
            await ctx.commands.run(invocation.id, invocation.args, {
              ...ctx.commands.context(),
              command: "prompt.submit",
            });
          } catch (error) {
            if (ctx.active()) {
              ctx.change((current) => current === prepared ? draft : current);
            }
            ctx.fail(error);
          }
          return true;
        },
        async submit(draft, parts, selection) {
          const parsed = draft.mode === "normal"
            ? parseCommand(draft.input)
            : undefined;
          if (!parsed) return false;
          const invocation = ctx.commands.parse(
            parsed.command,
            parseCommand(parts.find((part) => part.kind === "text")!.text)!
              .arguments,
          );
          if (!invocation) return false;
          await ctx.commands.run(invocation.id, {
            ...(invocation.args as object ?? {}),
            selection,
            parts: parts.filter((
              part,
            ): part is Extract<PromptPart, { kind: "file" }> =>
              part.kind === "file"
            ),
          });
          return true;
        },
      };
    },
  });
}
