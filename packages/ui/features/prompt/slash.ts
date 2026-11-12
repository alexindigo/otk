// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptChoices, PromptRegistry } from "../../registries/prompt.ts";
import { createSignal } from "solid-js";
import {
  commandOptions,
  parseCommand,
} from "../../components/prompt/autocomplete.ts";
import { editDraft } from "../../components/prompt/model.ts";
import type { CommandOption, PromptPart } from "@otk/protocol";
export function registerSlashPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "slash",
    create: (ctx) => {
      const [revision, setRevision] = createSignal(0);
      ctx.mount(() =>
        ctx.commands.subscribe(() => setRevision((value) => value + 1))
      );
      const registered = new Map<
        string,
        { signature: string; release: () => void }
      >();
      let server: CommandOption[] = [], mounted = false;
      ctx.own(() => {
        for (const entry of registered.values()) entry.release();
        registered.clear();
      });
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
        const next = [...values?.commands?.value ?? []];
        for (const skill of values?.skills?.value ?? []) {
          if (!next.some((command) => command.name === skill.name)) {
            next.push({ ...skill, aliases: [], source: "skill" });
          }
        }
        if (!ctx.active()) return [];
        server = next.map((command) => ({
          ...command,
          aliases: command.aliases.slice(),
        }));
        for (const [name, entry] of registered) {
          if (!server.some((command) => command.name === name)) {
            entry.release();
            registered.delete(name);
          }
        }
        for (const command of server) {
          const name = command.name,
            signature = JSON.stringify(command),
            old = registered.get(name);
          if (old?.signature === signature) continue;
          old?.release();
          const id = `server.command:${name}`;
          const release = ctx.commands.register({
            id,
            title: command.description || command.name,
            category: "Server commands",
            name: command.name,
            aliases: command.aliases,
            source: command.source,
            kind: "submission",
            scope: "session",
            arguments: {
              type: "object",
              optional: true,
              rest: "arguments",
              properties: {
                arguments: { type: "string", optional: true },
                selection: { type: "object", optional: true },
                parts: { type: "array", optional: true },
              },
            },
            enabled: () => ctx.props.connected && ctx.supports("commands"),
            run: (
              _context,
              args: {
                arguments?: string;
                selection?: PromptChoices;
                parts?: Extract<PromptPart, { kind: "file" }>[];
              } = {},
            ) => {
              return ctx.submit(async (options) => {
                if (!args.selection) await ctx.ready();
                const selection = args.selection ??
                  ctx.nextSelection(ctx.change((draft) => draft)).input;
                await ctx.rpc("session.command", {
                  sessionID: ctx.sessionID(),
                  command: name,
                  arguments: args.arguments ?? "",
                  ...selection,
                  parts: (await ctx.attachments(args.parts ?? [])).filter((
                    part,
                  ): part is Extract<PromptPart, { kind: "file" }> =>
                    part.kind === "file"
                  ),
                }, options);
              });
            },
          });
          registered.set(name, { signature, release });
        }
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
