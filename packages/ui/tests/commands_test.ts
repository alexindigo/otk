// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { CommandHub, effectiveSelection, emptyDraft } from "@otk/client";
import { type PromptContext, PromptRegistry } from "../registries/prompt.ts";
import { registerSlashPrompt } from "../features/prompt/slash.ts";
import type { CommandOption } from "@otk/protocol";
import {
  commandOptions,
  parseCommand,
} from "../components/prompt/autocomplete.ts";
Deno.test("slash ranking gives trigger-inclusive name prefixes priority over description matches", () => {
  assertEquals(
    commandOptions([
      {
        name: "probe",
        description: "A project command",
        source: "server",
        aliases: [],
      },
      { name: "apro", description: "pro", source: "server", aliases: [] },
    ], "pro")[0].command?.name,
    "probe",
  );
});
Deno.test("command arguments retain first-line spacing and all subsequent lines; descriptions and aliases match", () => {
  assertEquals(parseCommand("/probe a  b\nsecond\nthird"), {
    command: "probe",
    arguments: "a  b\nsecond\nthird",
  });
  assertEquals(parseCommand("ordinary prompt"), undefined);
  assertEquals(
    commandOptions([{
      name: "probe",
      description: "Useful fixture",
      source: "server",
      aliases: ["canary"],
    }], "canary")[0].command?.name,
    "probe",
  );
  assertEquals(
    commandOptions([{
      name: "probe",
      description: "Useful fixture",
      source: "server",
      aliases: [],
    }], "Useful")[0].command?.name,
    "probe",
  );
});
Deno.test("registered slash aliases retain canonical native names and MCP source while invoking the owner ID", async () => {
  const commands = new CommandHub(),
    prompt = new PromptRegistry(),
    releases: (() => void)[] = [];
  const invoked: unknown[] = [];
  let active = true;
  const ctx = {
    commands,
    own: (release: () => void) => releases.push(release),
    active: () => active,
    supports: () => true,
    sessionID: () => "session",
    attachments: (parts: unknown[]) => Promise.resolve(parts),
    act: (action: () => Promise<unknown>) => action(),
    rpc: (method: string, params: Record<string, unknown>) => {
      if (method === "commands.list") {
        return Promise.resolve([{
          name: "probe",
          description: "Native probe",
          source: "mcp",
          aliases: ["shortcut"],
        }]);
      }
      invoked.push([
        params.command,
        params.arguments,
        params.parts,
        params.agent,
        params.model,
        params.variant,
      ]);
      return Promise.resolve();
    },
    props: {
      connected: true,
      value: { input: "", mode: "normal", chips: [] },
    },
    fail: (error: unknown) => {
      throw error;
    },
  } as unknown as PromptContext;
  registerSlashPrompt(prompt);
  const feature = prompt.create(ctx)[0];
  try {
    const options = await feature.source!.options({
      start: 0,
      end: 1,
      query: "shortcut",
    });
    assertEquals(options[0].command?.name, "probe");
    assertEquals(options[0].command?.source, "mcp");
    assertEquals(options[0].label, "/probe:mcp");
    await feature.submit!(
      {
        input: "/shortcut a\nsecond",
        mode: "normal",
        chips: [],
      },
      [{ kind: "text", text: "/shortcut a\nsecond" }],
      {
        agent: "review",
        model: { provider: "two", model: "chosen" },
        variant: "high",
      },
    );
    assertEquals(invoked, [["probe", "a\nsecond", [], "review", {
      provider: "two",
      model: "chosen",
    }, "high"]]);
  } finally {
    active = false;
    releases.forEach((release) => release());
  }
});
function catalogConsumer(load: () => Promise<CommandOption[]>) {
  const commands = new CommandHub(),
    prompt = new PromptRegistry(),
    releases: (() => void)[] = [];
  let active = true;
  const ctx = {
    commands,
    own: (release: () => void) => releases.push(release),
    active: () => active,
    supports: () => true,
    sessionID: () => "session",
    rpc: load,
    props: {
      connected: true,
      value: { input: "", mode: "normal", chips: [] },
    },
    fail: (error: unknown) => {
      throw error;
    },
  } as unknown as PromptContext;
  registerSlashPrompt(prompt);
  return {
    commands,
    source: prompt.create(ctx)[0].source!,
    stop: () => {
      active = false;
      releases.forEach((release) => release());
    },
  };
}
Deno.test("slash catalog owns response generations and updates changed native metadata without stale aliases", async () => {
  const pending: ((value: CommandOption[]) => void)[] = [];
  const consumer = catalogConsumer(() =>
    new Promise((resolve) => pending.push(resolve))
  );
  try {
    const old = consumer.source.options({ start: 0, end: 1, query: "probe" });
    const current = consumer.source.options({
      start: 0,
      end: 1,
      query: "probe",
    });
    assertEquals(pending.length, 2);
    pending[1]([{
      name: "probe",
      description: "Latest",
      source: "mcp",
      aliases: ["latest-alias"],
    }]);
    await current;
    pending[0]([{
      name: "probe",
      description: "Old",
      source: "server",
      aliases: ["old-alias"],
    }]);
    await old;
    assertEquals(consumer.commands.resolveSlash("old-alias"), undefined);
    assertEquals(
      consumer.commands.resolveSlash("latest-alias"),
      "server.command:probe",
    );
    assertEquals(consumer.commands.list()[0].cmd.title, "Latest");
    const changed = consumer.source.options({
      start: 0,
      end: 1,
      query: "probe",
    });
    pending[2]([{
      name: "probe",
      description: "Changed",
      source: "skill",
      aliases: ["changed-alias"],
    }]);
    await changed;
    assertEquals(consumer.commands.resolveSlash("latest-alias"), undefined);
    assertEquals(
      consumer.commands.resolveSlash("changed-alias"),
      "server.command:probe",
    );
    assertEquals(consumer.commands.list()[0].cmd.title, "Changed");
  } finally {
    consumer.stop();
  }
  assertEquals(consumer.commands.list(), []);
});
Deno.test("superseded slash catalog failures do not reach the current command or error consumer", async () => {
  const pending: {
    resolve(value: CommandOption[]): void;
    reject(error: Error): void;
  }[] = [];
  const consumer = catalogConsumer(() =>
    new Promise((resolve, reject) => pending.push({ resolve, reject }))
  );
  try {
    const old = consumer.source.options({ start: 0, end: 1, query: "probe" });
    const current = consumer.source.options({
      start: 0,
      end: 1,
      query: "probe",
    });
    pending[1].resolve([{ name: "probe", source: "server", aliases: [] }]);
    await current;
    pending[0].reject(new Error("Superseded lookup"));
    await old;
    assertEquals(
      consumer.commands.resolveSlash("probe"),
      "server.command:probe",
    );
  } finally {
    consumer.stop();
  }
});

Deno.test("palette native slash waits for composer readiness and sends the current projected selection", async () => {
  const commands = new CommandHub(),
    prompt = new PromptRegistry(),
    releases: (() => void)[] = [];
  let draft = { ...emptyDraft(), agent: "review" }, finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const received: unknown[] = [];
  const model = { provider: "ready", model: "chosen" };
  const ctx = {
    commands,
    own: (release: () => void) => releases.push(release),
    active: () => true,
    supports: () => true,
    sessionID: () => "session",
    attachments: (parts: unknown[]) => Promise.resolve(parts),
    act: (action: () => Promise<unknown>) => action(),
    ready: () => pending,
    change: (change: (value: typeof draft) => typeof draft) => change(draft),
    nextSelection: () =>
      effectiveSelection(draft, {
        agents: [],
        catalog: {
          providers: [{
            id: "ready",
            name: "Ready",
            models: [{
              id: "chosen",
              name: "Chosen",
              status: "active",
              variants: ["high"],
              free: false,
            }],
          }],
        },
      }),
    rpc: (method: string, params: unknown) =>
      method === "commands.list"
        ? Promise.resolve([{ name: "probe", source: "server", aliases: [] }])
        : (received.push(params), Promise.resolve()),
    props: { connected: true, value: draft },
    fail: (error: unknown) => {
      throw error;
    },
  } as unknown as PromptContext;
  registerSlashPrompt(prompt);
  try {
    await prompt.create(ctx)[0].source!.options({
      start: 0,
      end: 1,
      query: "probe",
    });
    const sent = commands.run("server.command:probe");
    await Promise.resolve();
    assertEquals(received, []);
    draft = { ...draft, model, variant: "high" } as typeof draft;
    finish();
    await sent;
    assertEquals(received, [{
      sessionID: "session",
      command: "probe",
      arguments: "",
      agent: "review",
      model,
      variant: "high",
      parts: [],
    }]);
  } finally {
    releases.forEach((release) => release());
  }
});
