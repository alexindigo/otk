// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandOption, SkillOption } from "@otk/protocol";
import type { CommandHub } from "./commands.ts";
export interface HarnessCommands {
  update(options: readonly CommandOption[]): void;
  dispose(): void;
}
export interface SkillChoice extends SkillOption {
  unavailable?: string;
}

/** Adapter data enters the same registry as local actions; surfaces never merge it. */
export function createHarnessCommands(hub: CommandHub, ports: {
  available(): boolean;
  execute(command: CommandOption, args: Record<string, unknown>): Promise<void>;
}): HarnessCommands {
  const registered = new Map<string, { signature: string; release(): void }>();
  return {
    update(options: readonly CommandOption[]) {
      const next = new Map(
        options.filter((option) => option.source !== "skill").map((command) => [
          `${
            command.source === "builtin" ? "harness" : "server"
          }.command:${command.name}`,
          command,
        ]),
      );
      for (const [id, entry] of registered) {
        if (!next.has(id)) {
          entry.release();
          registered.delete(id);
        }
      }
      for (const [id, command] of next) {
        const signature = JSON.stringify(command);
        const old = registered.get(id);
        if (old?.signature === signature) continue;
        old?.release();
        const release = hub.register({
          id,
          title: command.description || command.name,
          description: command.description,
          name: command.name,
          aliases: command.aliases,
          source: command.source,
          category: command.source === "builtin"
            ? "Harness commands"
            : "Server commands",
          action: command.action,
          priority: command.priority,
          kind: command.source === "builtin" ? "action" : "submission",
          scope: "session",
          arguments: command.source === "builtin" ? { type: "none" } : {
            type: "object",
            optional: true,
            rest: "arguments",
            properties: {
              arguments: { type: "string", optional: true },
              selection: { type: "object", optional: true },
              parts: { type: "array", optional: true },
            },
          },
          availability: () =>
            command.unavailable
              ? { available: false, reason: command.unavailable }
              : ports.available()
              ? { available: true }
              : {
                available: false,
                reason:
                  "Session is not connected or the command owner is inactive",
              },
          run: (_context, args: Record<string, unknown> = {}) =>
            ports.execute(command, args),
        });
        registered.set(id, { signature, release });
      }
    },
    dispose() {
      for (const entry of registered.values()) entry.release();
      registered.clear();
    },
  };
}

/** Conflict wording/semantics are adapter data, not client native-name knowledge. */
export function skillChoices(
  skills: readonly SkillOption[],
  commands: readonly CommandOption[],
): SkillChoice[] {
  return skills.map((skill) => ({
    ...skill,
    unavailable: commands.find((command) =>
      command.name === skill.name && command.skillConflict
    )?.skillConflict,
  }));
}
