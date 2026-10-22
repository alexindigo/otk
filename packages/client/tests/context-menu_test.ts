// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub, contextGroups } from "@otk/client";

Deno.test("context commands: captured targets, hidden contributions, grouping, availability and release", async () => {
  const commands = new CommandHub();
  let available = true, received = "";
  const release = commands.register({
    id: "session.close",
    title: "Close tab",
    category: "Session",
    hidden: true,
    context: { kind: "session", destructive: true },
    enabled: (_ctx, input?: { id: string }) => available && !!input?.id,
    run: (_ctx, input: { id: string }) => {
      received = input.id;
    },
  });
  commands.register({
    id: "session.copy",
    title: "Copy title",
    category: "Session",
    context: {
      kind: "session",
      title: (input: { id: string }) => `Copy ${input.id}`,
    },
    run: () => {},
  });
  for (const kind of ["code", "message", "app"]) {
    commands.register({
      id: kind,
      title: kind,
      category: kind,
      context: { kind },
      run: () => {},
    });
  }
  const groups = contextGroups(commands, [
    { kind: "missing", data: {} },
    { kind: "code", data: "source" },
    { kind: "session", data: { id: "origin" } },
    { kind: "message", data: {} },
  ]);
  assertEquals(groups.map((group) => group.map((action) => action.id)), [
    ["code"],
    ["session.copy", "session.close"],
  ]);
  assertEquals(groups[1][0].title, "Copy origin");
  assertEquals("run" in groups[1][1], false);
  available = false;
  await assertRejects(
    () => commands.run(groups[1][1].id, groups[1][1].args),
    Error,
    "unavailable",
  );
  assertEquals(received, "");
  assertEquals(
    commands.contextActions({ kind: "session", data: { id: "origin" } }).map((
      action,
    ) => action.id),
    ["session.copy"],
  );
  available = true;
  await commands.run(groups[1][1].id, groups[1][1].args);
  assertEquals(received, "origin");
  release();
  assertEquals(
    commands.contextActions({ kind: "session", data: { id: "origin" } }).map((
      action,
    ) => action.id),
    ["session.copy"],
  );
  assertEquals(
    contextGroups(commands, []).map((group) =>
      group.map((action) => action.id)
    ),
    [["app"]],
  );
  assertEquals(contextGroups(commands, [{ kind: "missing", data: {} }]), []);
});

Deno.test("context contributions: one command projects multiple independently available items and rechecks their current args", async () => {
  const commands = new CommandHub();
  type Input = { session: string; task?: string };
  let tasks = ["one", "two"], received: Input | undefined;
  commands.register({
    id: "task.add",
    title: "Add to task",
    category: "Task",
    hidden: true,
    context: {
      kind: "session",
      items: (input: Input) =>
        tasks.map((task) => ({
          key: task,
          title: `Add to ${task}`,
          args: { ...input, task },
        })),
    },
    enabled: (_ctx, input?: Input) => input?.task !== "two",
    run: (_ctx, input: Input) => {
      received = input;
    },
  });
  const [item] = commands.contextActions({
    kind: "session",
    data: { session: "origin" },
  });
  assertEquals(
    commands.contextActions({ kind: "session", data: { session: "origin" } })
      .map((item) => item.title),
    ["Add to one"],
  );
  await commands.runContext(item);
  assertEquals(received, { session: "origin", task: "one" });
  tasks = ["two"];
  await assertRejects(
    () => commands.runContext(item),
    Error,
    "This action is no longer available.",
  );
  assertEquals(commands.list().length, 0);
});

Deno.test("context invocation: released or replaced command owners cannot consume an old action", async () => {
  const commands = new CommandHub();
  let received = "";
  const definition = {
    id: "reply.copy",
    title: "Copy reply",
    category: "Reply",
    context: { kind: "reply" },
    run: (_ctx: unknown, text: string) => {
      received = text;
    },
  };
  const release = commands.register(definition);
  const [action] = commands.contextActions({
    kind: "reply",
    data: "old reply",
  });
  release();
  commands.register(definition);
  await assertRejects(
    () => commands.runContext(action),
    Error,
    "This action is no longer available.",
  );
  assertEquals(received, "");
});

Deno.test("context areas: inner groups precede their area, app follows only area-only hits, unavailable things never become app space", async () => {
  const commands = new CommandHub();
  for (
    const kind of [
      "code",
      "reply",
      "project",
      "session",
      "projects",
      "panel",
      "composer",
      "app",
    ]
  ) {
    commands.register({
      id: kind,
      title: kind,
      category: "Test",
      context: { kind },
      run: (_ctx, data: unknown) => data,
    });
  }
  const ids = (targets: Parameters<typeof contextGroups>[1]) =>
    contextGroups(commands, targets).map((group) =>
      group.map((action) => action.id)
    );
  const area = (kind: string) => ({ kind, area: true, data: "captured" });
  for (const kind of ["projects", "panel", "session", "composer"]) {
    assertEquals(ids([area(kind)]), [[kind], ["app"]]);
  }
  assertEquals(ids([{ kind: "project", data: {} }, area("projects")]), [[
    "project",
  ], ["projects"]]);
  assertEquals(
    ids([
      { kind: "code", data: {} },
      { kind: "reply", data: {} },
      area("session"),
    ]),
    [["code"], ["reply"], ["session"]],
  );
  assertEquals(ids([{ kind: "missing", data: {} }, area("projects")]), [[
    "projects",
  ]]);
  assertEquals(ids([area("missing")]), [["app"]]);
  assertEquals(ids([area("projects"), area("panel")]), [["projects"], ["app"]]);
  const [action] = contextGroups(commands, [area("session")])[0];
  assertEquals(await commands.runContext<string>(action), "captured");
});

Deno.test("context areas: one command serves several kinds and shared app actions appear only in the most specific group", async () => {
  const commands = new CommandHub();
  const kinds = ["panel", "app"];
  let calls = 0;
  commands.register({
    id: "new",
    title: "New session",
    category: "Test",
    context: { kind: kinds },
    run: () => ++calls,
  });
  kinds.length = 0;
  commands.register({
    id: "palette",
    title: "Palette",
    category: "Test",
    context: { kind: "app" },
    run: () => {},
  });
  const groups = contextGroups(commands, [{
    kind: "panel",
    area: true,
    data: undefined,
  }]);
  assertEquals(groups.map((group) => group.map((action) => action.id)), [[
    "new",
  ], ["palette"]]);
  await commands.runContext(groups[0][0]);
  assertEquals(calls, 1);
  assertEquals(
    commands.contextActions({ kind: "app", data: undefined }).map((action) =>
      action.id
    ),
    ["new", "palette"],
  );
});
