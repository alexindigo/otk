// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub, createSessionRename, type Selection } from "@otk/client";
import { registerSessionTargetCommands } from "../shell/commands/sessions.ts";
import { registerSessionActionCommands } from "../shell/commands/session-actions.ts";

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
