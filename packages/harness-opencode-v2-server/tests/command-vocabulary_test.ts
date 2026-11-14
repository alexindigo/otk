// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { nativeCommands } from "../command-vocabulary.ts";
import { mapCommands, mergeCommands } from "../catalog-readers.ts";
import { commands } from "../commands.ts";
import type { V2Client } from "../client.ts";
import { opencodeV2SessionID } from "../ids.ts";

Deno.test("V2 2.2.6 contributes its complete native client vocabulary and aliases", () => {
  const commands = nativeCommands();
  assertEquals(
    commands.flatMap((command) => [command.name, ...command.aliases]).sort(),
    [
      "compact",
      "new",
      "clear",
      "undo",
      "redo",
      "fork",
      "rename",
      "timeline",
      "export",
      "copy",
      "model",
      "models",
      "agent",
      "agents",
      "variants",
      "thinking",
      "effort",
      "connect",
      "reload",
      "mcp",
      "mcps",
      "sessions",
      "resume",
      "continue",
      "open",
      "projects",
      "project",
      "usage",
      "stats",
      "settings",
      "status",
      "debug",
      "themes",
      "help",
      "editor",
      "skills",
      "worktrees",
      "cd",
      "terminal",
      "btw",
      "diff",
      "plugins",
      "highlights",
      "update",
      "pair",
      "web",
      "restart",
      "exit",
      "quit",
      "q",
    ].sort(),
  );
  assertEquals(
    commands.find((command) => command.aliases.includes("thinking"))?.action,
    "variant.choose",
  );
  assertEquals(
    commands.find((command) => command.name === "clear")?.unavailable,
    "not supported yet",
  );
  assertEquals(
    commands.every((command) => !!command.action !== !!command.unavailable),
    true,
  );
});

Deno.test("V2 server names win local names and same-named skills keep independent identities", () => {
  const commands = mapCommands([{
    name: "compact",
    description: "Server override",
  }]);
  const merged = mergeCommands(commands, [{
    id: "skill-compact",
    name: "compact",
  }]);
  assertEquals(
    commands.filter((command) => command.name === "compact").length,
    2,
  );
  assertEquals(
    commands.find((command) => command.source !== "builtin")!.priority! >
      commands.find((command) => command.source === "builtin")!.priority!,
    true,
  );
  assertEquals(
    merged.find((command) => command.source === "skill")?.skillID,
    "skill-compact",
  );
});

Deno.test("V2 explicit skill ID dispatches the skill route, never the same-named command", async () => {
  const effects: unknown[] = [];
  const api = {
    session: {
      get: () =>
        Promise.resolve({ id: "native", location: { directory: "/project" } }),
      command: (input: unknown) => {
        effects.push(["command", input]);
        return Promise.resolve();
      },
    },
    command: { list: () => Promise.resolve({ data: [{ name: "same" }] }) },
    skill: {
      list: () =>
        Promise.resolve({
          data: [{ id: "skill-one", name: "same", path: "/project/skill" }],
        }),
    },
    experimental: {
      session: {
        skill: (input: unknown) => {
          effects.push(["skill", input]);
          return Promise.resolve();
        },
      },
    },
  };
  const client = {
    read: (action: (api: unknown) => unknown) => action(api),
    effect: (action: (api: unknown) => unknown) => action(api),
    sequence: (_id: string, action: () => unknown) => action(),
  } as unknown as V2Client;
  const owner = commands(() => client);
  await owner.command({
    sessionID: opencodeV2SessionID.encode("native"),
    command: "same",
    skill: { id: "skill-one", name: "same" },
    arguments: "",
  });
  assertEquals(effects, [["skill", { sessionID: "native", id: "skill-one" }]]);
  effects.length = 0;
  await owner.command({
    sessionID: opencodeV2SessionID.encode("native"),
    command: "same",
    arguments: "server arguments",
  });
  assertEquals(effects, [["command", {
    sessionID: "native",
    name: "same",
    text: "server arguments",
    files: [],
  }]]);
});
