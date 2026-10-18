// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptChoices, PromptRegistry } from "../../registries/prompt.ts";
import { onSettled } from "solid-js";
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
      onSettled(() => {
        if (!ctx.commands.has("session.new")) {
          return ctx.commands.register({
            id: "session.new",
            title: "New session",
            category: "Session",
            slash: ["new"],
            run: async () => {
              const info = await ctx.rpc("session.create", {
                directory: await ctx.directory(),
              });
              await ctx.commands.run("session.open", { sessionID: info.id });
            },
          });
        }
      });
      const registered = new Map<
        string,
        { signature: string; release: () => void }
      >();
      let generation = 0, server: CommandOption[] = [];
      ctx.own(() => {
        generation++;
        for (const entry of registered.values()) entry.release();
        registered.clear();
      });
      const options = () => {
        const rows = ctx.commands.list().flatMap(({ cmd }) => {
          if (!cmd.slash?.length) return [];
          const name = cmd.slash[0];
          return [{
            name,
            description: cmd.title,
            aliases: cmd.slash.slice(1),
            source: cmd.id.startsWith("server.command:")
              ? server.find((row) => row.name === name)?.source ??
                "server" as const
              : "builtin" as const,
          }];
        });
        return rows.filter((option, index) =>
          rows.findIndex((row) => row.name === option.name) === index
        );
      };
      const catalog = async () => {
        if (!ctx.props.connected || !ctx.supports("commands")) {
          return options();
        }
        const revision = ++generation;
        let next: CommandOption[];
        try {
          next = await ctx.rpc("commands.list", { sessionID: ctx.sessionID() });
        } catch (error) {
          if (ctx.active() && revision === generation) throw error;
          return options();
        }
        if (!ctx.active()) return [];
        if (revision !== generation) return options();
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
            slash: [command.name, ...command.aliases],
            enabled: () => ctx.props.connected && ctx.supports("commands"),
            run: (
              _context,
              args: {
                arguments?: string;
                selection?: PromptChoices;
                parts?: Extract<PromptPart, { kind: "file" }>[];
              } = {},
            ) => {
              return ctx.act(async () => {
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
                });
              });
            },
          });
          registered.set(name, { signature, release });
        }
        return options();
      };
      onSettled(() => {
        void catalog().catch(ctx.fail);
      });
      return {
        source: {
          trigger(input, caret) {
            const before = input.slice(0, caret);
            return /^\/[^\s]*$/.test(before)
              ? { start: 0, end: caret, query: before.slice(1) }
              : undefined;
          },
          options: async (token) =>
            commandOptions(await catalog(), token.query),
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
              return next;
            }, command.source === "builtin" ? 0 : command.name.length + 2);
            if (command.source === "builtin") {
              const id = ctx.commands.resolveSlash(command.name);
              if (id) void ctx.commands.run(id).catch(ctx.fail);
            }
          },
        },
        async beforeSubmit(draft) {
          const parsed = draft.mode === "normal"
            ? parseCommand(draft.input)
            : undefined;
          if (!parsed) return false;
          const id = ctx.commands.resolveSlash(parsed.command);
          if (!id || id.startsWith("server.command:")) return false;
          ctx.change((current) =>
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
            await ctx.commands.run(id);
          } catch (error) {
            ctx.fail(error);
          }
          return true;
        },
        async submit(draft, parts, selection) {
          const parsed = draft.mode === "normal"
            ? parseCommand(draft.input)
            : undefined;
          const command = parsed &&
            (await catalog()).find((command) =>
              command.name === parsed.command ||
              command.aliases.includes(parsed.command)
            );
          if (!command) return false;
          await ctx.commands.run(ctx.commands.resolveSlash(command.name)!, {
            selection,
            arguments: parseCommand(
              parts.find((part) => part.kind === "text")!.text,
            )!.arguments,
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
