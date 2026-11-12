// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { CommandHub } from "@otk/client";

Deno.test("structured and schema-parsed text invocations share validation, target and reason", async () => {
  const hub = new CommandHub();
  const received: unknown[] = [];
  let connected = true;
  hub.register({
    id: "fixture.rename",
    name: "rename",
    aliases: ["name"],
    title: "Rename",
    category: "Fixture",
    scope: "session",
    arguments: {
      type: "object",
      properties: { session: { type: "string" }, title: { type: "string" } },
    },
    availability: () =>
      connected
        ? { available: true }
        : { available: false, reason: "Server disconnected" },
    run: (_ctx, input: { session: string; title: string }) => {
      received.push(input);
    },
  });
  const input = { session: "captured", title: "New title" };
  const parsed = hub.parse("name", JSON.stringify(input))!;
  await hub.run(parsed.id, parsed.args);
  await hub.run("fixture.rename", input);
  assertEquals(received, [input, input]);
  await assertRejects(
    () => hub.run("fixture.rename", { session: 12 }),
    Error,
    "arguments.session",
  );
  assertThrows(
    () => hub.parse("rename", '{"session":12}'),
    Error,
    "arguments.session",
  );
  assertEquals(received.length, 2);
  assertEquals(
    hub.list()[0].availability.available,
    false,
    "Missing target is unavailable, not missing from inventory",
  );
  connected = false;
  assertEquals(hub.availability("fixture.rename", undefined, input), {
    available: false,
    reason: "Server disconnected",
  });
  await assertRejects(
    () => hub.run("fixture.rename", input),
    Error,
    "Server disconnected",
  );
});

Deno.test("name conflicts have one display/execution resolution independent of availability and order", () => {
  for (const order of [["one", "two"], ["two", "one"]]) {
    const hub = new CommandHub();
    for (const id of order) {
      hub.register({
        id,
        name: "shared",
        title: id,
        category: "Fixture",
        enabled: () => id === "one",
        run: () => {},
      });
    }
    assertThrows(() => hub.resolveSlash("shared"), Error, "Ambiguous command");
    assertEquals(hub.list().map(({ cmd }) => hub.spelling(cmd.id)).sort(), [
      "one",
      "two",
    ]);
    assertEquals(hub.resolveSlash("one"), "one");
  }
});

Deno.test("descriptors snapshot schemas and retain no executable closures", () => {
  const hub = new CommandHub();
  const schema = {
    type: "object" as const,
    properties: { value: { type: "string" as const } },
  };
  hub.register({
    id: "fixture",
    title: "Fixture",
    category: "Fixture",
    arguments: schema,
    run: () => {},
  });
  const metadata = hub.metadata("fixture")!;
  assertEquals(JSON.parse(JSON.stringify(metadata)).arguments, schema);
  assertEquals(Object.isFrozen(metadata.arguments!.properties!.value), true);
  schema.properties.value = { type: "string" };
  assertThrows(
    () => hub.parse("fixture", '{"value":42}'),
    Error,
    "expected string",
  );
});

Deno.test("text command execution cannot recursively submit its input or bypass context confirmation", async () => {
  const hub = new CommandHub();
  let calls = 0;
  hub.register({
    id: "input.submit",
    title: "Submit",
    category: "Input",
    run: () => calls++,
  });
  await assertRejects(
    () => hub.run("input.submit", undefined, { command: "input.submit" }),
    Error,
    "already being handled",
  );
  hub.register({
    id: "delete",
    title: "Delete",
    category: "Fixture",
    arguments: { type: "string" },
    context: { kind: "fixture", confirm: () => "Confirm deletion" },
    run: () => calls++,
  });
  await assertRejects(() => hub.run("delete", "target"), Error, "confirmation");
  const [action] = hub.contextActions({ kind: "fixture", data: "target" });
  await hub.runContext(action);
  assertEquals(calls, 1);
});

Deno.test("ordinary command invocation shares confirmation without losing its captured target", async () => {
  const questions: string[] = [], calls: string[] = [];
  let consent = false;
  const hub = new CommandHub(() => ({}), () => [], (text) => {
    questions.push(text);
    return consent;
  });
  hub.register({
    id: "delete",
    title: "Delete",
    category: "Fixture",
    arguments: { type: "string" },
    context: {
      kind: "fixture",
      confirm: (target: string) => `Delete ${target}?`,
    },
    run: (_ctx, target: string) => {
      calls.push(target);
    },
  });
  const parsed = hub.parse("delete", "captured")!;
  await assertRejects(
    () => hub.run(parsed.id, parsed.args),
    Error,
    "cancelled",
  );
  assertEquals(calls, []);
  consent = true;
  await hub.run(parsed.id, parsed.args);
  assertEquals(calls, ["captured"]);
  await hub.runContext(
    hub.contextActions({ kind: "fixture", data: "context target" })[0],
  );
  assertEquals(questions, ["Delete captured?", "Delete captured?"]);
  assertEquals(calls, ["captured", "context target"]);
});
