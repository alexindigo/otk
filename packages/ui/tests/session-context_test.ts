// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub, createSessionRename, type Selection } from "@otk/client";
import { registerSessionTargetCommands } from "../shell/commands/sessions.ts";
import { registerSessionActionCommands } from "../shell/commands/session-actions.ts";
import type { SessionRevert } from "@otk/client";

Deno.test("code revert and archive contributions require independent capabilities and capture the menu target", async () => {
  const commands = new CommandHub(), calls: unknown[] = [];
  const target = {
    sidecarId: "one",
    sessionID: "source",
    directory: "/p",
    title: "Source",
  };
  let available = false, archived: boolean | undefined = false;
  const revert: SessionRevert = {
    state: {},
    matches: () => true,
    revertTo: (id, code) => {
      calls.push([id, code]);
      return Promise.resolve();
    },
    restore: () => Promise.resolve(),
    undo: () => Promise.resolve(),
    redo: () => Promise.resolve(),
    hasPrompt: () => true,
    strip: () => undefined,
    dispose() {},
  };
  const release = registerSessionActionCommands(commands, {
    available: () => true,
    current: () => target,
    rename: createSessionRename({ rename: () => Promise.resolve() }),
    remove: () => Promise.resolve(true),
    working: () => false,
    helpers: () => 0,
    fork: () => Promise.resolve(),
    revert,
    revertAvailable: (_target, capability) =>
      capability === "revert" || available,
    archiveAvailable: () => available,
    archived: () => archived,
    archive: (captured, value) => {
      calls.push([captured, value]);
      archived = value;
      return Promise.resolve();
    },
  });
  const prompt = () =>
    commands.contextActions({
      kind: "prompt",
      data: { ...target, messageID: "boundary" },
    });
  const session = () =>
    commands.contextActions({ kind: "session", data: target });
  assertEquals(prompt().map((c) => c.title), ["Revert to here"]);
  assertEquals(session().some((c) => c.id === "session.archive"), false);
  available = true;
  assertEquals(prompt().map((c) => c.title), [
    "Revert to here",
    "Revert code changes",
  ]);
  await commands.runContext(
    prompt().find((c) => c.id === "prompt.revertCode")!,
  );
  assertEquals(calls.at(-1), ["boundary", true]);
  await commands.runContext(session().find((c) => c.id === "session.archive")!);
  assertEquals(calls.at(-1), [target, true]);
  assertEquals(session().some((c) => c.id === "session.archive"), false);
  assertEquals(session().some((c) => c.id === "session.unarchive"), true);
  archived = undefined;
  assertEquals(
    session().some((c) =>
      c.id === "session.archive" || c.id === "session.unarchive"
    ),
    false,
  );
  release();
});

for (
  const [working, helpers, expected] of [
    [false, 0, "Press again to delete"],
    [false, 1, "Press again to delete, including 1 helper"],
    [false, 3, "Press again to delete, including 3 helpers"],
    [true, 0, "Press again to stop and delete"],
    [true, 1, "Press again to stop and delete, including 1 helper"],
    [true, 3, "Press again to stop and delete, including 3 helpers"],
  ] as const
) {
  Deno.test(`armed Delete label working=${working} helpers=${helpers}`, () => {
    const commands = new CommandHub();
    const release = registerSessionActionCommands(commands, {
      available: () => true,
      rename: createSessionRename({ rename: () => Promise.resolve() }),
      working: () => working,
      helpers: () => helpers,
      remove: () => Promise.resolve(true),
      current: () => undefined,
      fork: () => Promise.resolve(),
    });
    try {
      const actions = commands.contextActions({
        kind: "session",
        data: {
          sidecarId: "server",
          sessionID: "session",
          directory: "/p",
          title: "Title",
        },
      });
      assertEquals(
        actions.find((action) => action.id === "session.delete")?.confirm,
        expected,
      );
    } finally {
      release();
    }
  });
}

Deno.test("session context transitions: current-place no-ops vanish, background and cross-server actions retain captured effects", async () => {
  const commands = new CommandHub();
  const target = { sidecarId: "one", sessionID: "same" };
  let current: Selection | undefined = target,
    inTask = false,
    exists = true,
    connected = true;
  const effects: unknown[] = [];
  const release = registerSessionTargetCommands(commands, {
    current: () => current,
    exists: () => exists,
    connected: () => connected,
    inTask: () => inTask,
    open: (value) => {
      current = value;
      effects.push(["open", value]);
      return true;
    },
    pin: (value) => {
      current = value;
      inTask = true;
      effects.push(["task", value]);
      return Promise.resolve(true);
    },
    close: (value = current) => {
      effects.push(["close", value]);
      return Promise.resolve(true);
    },
  });
  const items = () =>
    commands.contextActions({ kind: "session", data: target });
  const titles = () => items().map((item) => item.title);
  assertEquals(titles(), ["Pin as task", "Close session"]);
  assertEquals(
    commands.contextActions({ kind: "session", data: undefined }),
    [],
  );
  assertEquals(
    commands.list().find((c) => c.cmd.id === "session.close")?.cmd.title,
    "Close session",
  );
  await commands.runContext(items()[0]);
  assertEquals(effects, [["task", target]]);
  assertEquals(titles(), ["Close session"]);
  current = { sidecarId: "one", sessionID: "other" };
  assertEquals(titles(), ["Open", "Open as task", "Close session"]);
  const [open, task] = items();
  await commands.runContext(open);
  assertEquals(current, target);
  assertEquals(titles(), ["Close session"]);
  await assertRejects(
    () => commands.runContext(task),
    Error,
    "no longer available",
  );
  // Same session ID on another sidecar is not the same place.
  current = { sidecarId: "two", sessionID: "same" };
  assertEquals(titles(), ["Open", "Open as task", "Close session"]);
  connected = false;
  assertEquals(titles(), ["Open"]);
  exists = false;
  assertEquals(titles(), []);
  exists = connected = true;
  current = target;
  // Visible controls can still re-select, independently of context projection.
  await commands.run("session.preview", target);
  assertEquals(effects.at(-1), ["open", target]);
  assertEquals(titles(), ["Close session"]);
  await commands.runContext(
    items().find((item) => item.title === "Close session")!,
  );
  assertEquals(effects.at(-1), ["close", target]);
  release();
  assertEquals(items(), []);
});

Deno.test("fork commands share availability and capture complete reply boundaries", async () => {
  const commands = new CommandHub();
  const target = {
    sidecarId: "one",
    sessionID: "source",
    title: "Source",
    directory: "/p",
  };
  let available = true;
  const calls: unknown[] = [];
  const release = registerSessionActionCommands(commands, {
    available: () => available,
    current: () => target,
    rename: createSessionRename({ rename: () => Promise.resolve() }),
    remove: () => Promise.resolve(true),
    working: () => false,
    helpers: () => 0,
    fork: (target, through) => {
      calls.push([target, through]);
      return Promise.resolve();
    },
  });
  try {
    const data = {
      ...target,
      messageID: "first",
      lastID: "last",
      completed: false,
    };
    assertEquals(commands.contextActions({ kind: "reply", data }), []);
    data.completed = true;
    await commands.runContext(
      commands.contextActions({ kind: "reply", data })[0],
    );
    assertEquals(calls, [[{ sidecarId: "one", sessionID: "source" }, "last"]]);
    await commands.run("session.fork");
    assertEquals(calls.at(-1), [target, undefined]);
    available = false;
    assertEquals(commands.contextActions({ kind: "reply", data }), []);
    assertEquals(
      commands.contextActions({ kind: "session", data: target }),
      [],
    );
    await assertRejects(
      () => commands.run("session.fork"),
      Error,
      "unavailable",
    );
  } finally {
    release();
  }
});
