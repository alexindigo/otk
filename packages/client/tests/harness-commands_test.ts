// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { CommandHub, createHarnessCommands, skillChoices } from "../mod.ts";

Deno.test("adapter precedence owns friendly names; exact IDs and semantic schemas remain usable", async () => {
  const hub = new CommandHub();
  const received: unknown[] = [];
  const contributions = createHarnessCommands(hub, {
    available: () => true,
    execute: (command, args) => {
      received.push([command.name, args]);
      return Promise.resolve();
    },
  });
  const options = [
    {
      name: "echo",
      source: "builtin" as const,
      action: "fixture.echo",
      aliases: ["repeat"],
      priority: 10,
    },
    { name: "echo", source: "server" as const, aliases: [], priority: 20 },
  ];
  for (const reversed of [false, true]) {
    contributions.update(reversed ? options.toReversed() : options);
    assertEquals(hub.resolveSlash("echo"), "server.command:echo");
    assertEquals(hub.spelling("harness.command:echo"), "harness.command:echo");
  }
  const release = hub.register({
    id: "fixture.echo",
    title: "Echo",
    category: "Fixture",
    arguments: { type: "string" },
    run: (_ctx, args: string) => {
      received.push(args);
    },
  });
  assertEquals(hub.parse("repeat", "a phrase"), {
    id: "harness.command:echo",
    args: "a phrase",
  });
  await hub.run("harness.command:echo", "a phrase");
  assertEquals(received, ["a phrase"]);
  release();
  await assertRejects(
    () => hub.run("harness.command:echo"),
    Error,
    "owner inactive",
  );
  contributions.dispose();
  assertEquals(hub.list(), []);
});

Deno.test("unsupported native commands are recognized and refuse execution rather than being prompts", async () => {
  const hub = new CommandHub();
  const owner = createHarnessCommands(hub, {
    available: () => true,
    execute: () => {
      throw new Error("must not execute");
    },
  });
  owner.update([{
    name: "terminal",
    aliases: [],
    source: "builtin",
    unavailable: "not supported yet",
  }]);
  assertEquals(hub.resolveSlash("terminal"), "harness.command:terminal");
  assertEquals(hub.list()[0].availability, {
    available: false,
    reason: "not supported yet",
  });
  await assertRejects(
    () => hub.run("harness.command:terminal"),
    Error,
    "not supported yet",
  );
});

Deno.test("native skill conflicts remain picker choices, never individual registry commands", () => {
  const hub = new CommandHub();
  const owner = createHarnessCommands(hub, {
    available: () => true,
    execute: () => Promise.resolve(),
  });
  owner.update([{ name: "secret", aliases: [], source: "skill" }]);
  assertEquals(hub.list(), []);
  assertEquals(
    skillChoices([{ id: "one", name: "same" }], [{
      name: "same",
      aliases: [],
      source: "server",
      skillConflict: "native conflict",
    }]),
    [{ id: "one", name: "same", unavailable: "native conflict" }],
  );
  assertEquals(
    skillChoices([{ id: "one", name: "same" }], [{
      name: "same",
      aliases: [],
      source: "server",
    }])[0].unavailable,
    undefined,
  );
});

Deno.test("semantic bindings cannot form a cycle even when the target mounts later", () => {
  const hub = new CommandHub();
  hub.register({
    id: "one",
    action: "two",
    title: "One",
    category: "Fixture",
    run() {},
  });
  assertThrows(
    () =>
      hub.register({
        id: "two",
        action: "one",
        title: "Two",
        category: "Fixture",
        run() {},
      }),
    Error,
    "Cyclic",
  );
});
