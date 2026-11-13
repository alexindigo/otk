// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { nativeCommands } from "../command-vocabulary.ts";
import { commands, mapCommands, mergeCommands } from "../commands.ts";
import type { Client } from "../client.ts";
import type { Directory } from "../directory.ts";
import { opencodeV1SessionID } from "../ids.ts";
import {
  CommandHub,
  createHarnessCommands,
  registerPreferenceCommands,
} from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";

Deno.test("V1 1.19.3 contributes its complete native client vocabulary and aliases", () => {
  const commands = nativeCommands();
  assertEquals(
    commands.flatMap((command) => [command.name, ...command.aliases]).sort(),
    [
      "compact",
      "summarize",
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
      "mo",
      "agent",
      "agents",
      "variants",
      "connect",
      "mcp",
      "mcps",
      "sessions",
      "resume",
      "continue",
      "open",
      "status",
      "debug",
      "themes",
      "help",
      "editor",
      "skills",
      "terminal",
      "diff",
      "update",
      "exit",
      "quit",
      "q",
      "org",
      "orgs",
      "switch-org",
      "workspace",
      "workspaces",
      "warp",
      "move",
      "timestamps",
      "toggle-timestamps",
      "thinking",
      "toggle-thinking",
    ].sort(),
  );
  assertEquals(
    commands.find((command) => command.name === "thinking")?.action,
    "prefs.toggle.thinking",
  );
  assertEquals(
    commands.find((command) => command.aliases.includes("clear"))?.action,
    "session.new",
  );
  assertEquals(
    commands.find((command) => command.name === "copy")?.unavailable,
    "not supported yet",
  );
  assertEquals(
    commands.every((command) => !!command.action !== !!command.unavailable),
    true,
  );
});

Deno.test("V1 local autocomplete names win server names; skills are not commands", () => {
  const commands = mapCommands([{ name: "compact" }, {
    name: "canary",
    source: "skill",
  }]);
  assertEquals(commands.some((command) => command.name === "canary"), false);
  const local = commands.find((command) =>
    command.name === "compact" && command.source === "builtin"
  )!;
  const server = commands.find((command) =>
    command.name === "compact" && command.source === "server"
  )!;
  assertEquals(local.priority! > server.priority!, true);
  assertEquals(
    server.skillConflict,
    "Shadowed by the server command /compact in opencode 1.x",
  );
});

Deno.test("V1 rechecks skill shadowing before dispatch, including stale picker choices", async () => {
  let launched = 0;
  let source = "command";
  const client = {
    json: () => Promise.resolve([{ name: "same", source }]),
  } as unknown as Client;
  const directory = {
    resolve: () => Promise.resolve("/project"),
  } as unknown as Directory;
  const owner = commands(client, directory, () => {
    launched++;
  });
  const input = {
    sessionID: opencodeV1SessionID.encode("native"),
    command: "same",
    skill: { name: "same" },
    arguments: "",
  };
  await assertRejects(
    () => owner.command(input),
    Error,
    "Shadowed by the server command /same in opencode 1.x",
  );
  assertEquals(launched, 0);
  source = "skill";
  await owner.command(input);
  assertEquals(launched, 1);
});

Deno.test("V1 thinking invokes the real reasoning preference owner", async () => {
  const hub = new CommandHub();
  let prefs = { ...DEFAULT_PREFS };
  const release = registerPreferenceCommands(hub, {
    ready: () => true,
    prefs: () => prefs,
    set: (key, value) => {
      prefs = { ...prefs, [key]: value };
      return Promise.resolve();
    },
  });
  const owner = createHarnessCommands(hub, {
    available: () => true,
    execute: () => {
      throw new Error("not a native submission");
    },
  });
  owner.update(nativeCommands());
  await hub.run(hub.resolveSlash("thinking")!);
  assertEquals(prefs.thinking, "show");
  await hub.run(hub.resolveSlash("toggle-thinking")!);
  assertEquals(prefs.thinking, "hide");
  owner.dispose();
  release();
});

Deno.test("V1 fallback skill metadata never exposes native skill bodies", () => {
  const raw = {
    name: "same",
    description: "A skill",
    content: "private skill body",
    location: "/project/skills/same/SKILL.md",
  };
  assertEquals(mergeCommands([], [raw]), [{
    name: "same",
    description: "A skill",
    aliases: [],
    source: "skill",
  }]);
});
