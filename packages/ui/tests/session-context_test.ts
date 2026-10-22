// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub, type Selection } from "@otk/client";
import { registerSessionTargetCommands } from "../shell/commands/sessions.ts";

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
  });
  const items = () =>
    commands.contextActions({ kind: "session", data: target });
  const titles = () => items().map((item) => item.title);
  assertEquals(titles(), ["Pin as task"]);
  assertEquals(
    commands.contextActions({ kind: "session", data: undefined }),
    [],
  );
  await commands.runContext(items()[0]);
  assertEquals(effects, [["task", target]]);
  assertEquals(titles(), []);
  current = { sidecarId: "one", sessionID: "other" };
  assertEquals(titles(), ["Open", "Open as task"]);
  const [open, task] = items();
  await commands.runContext(open);
  assertEquals(current, target);
  assertEquals(titles(), []);
  await assertRejects(
    () => commands.runContext(task),
    Error,
    "no longer available",
  );
  // Same session ID on another sidecar is not the same place.
  current = { sidecarId: "two", sessionID: "same" };
  assertEquals(titles(), ["Open", "Open as task"]);
  connected = false;
  assertEquals(titles(), ["Open"]);
  exists = false;
  assertEquals(titles(), []);
  exists = connected = true;
  current = target;
  // Visible controls can still re-select, independently of context projection.
  await commands.run("session.preview", target);
  assertEquals(effects.at(-1), ["open", target]);
  assertEquals(titles(), []);
  release();
  assertEquals(items(), []);
});
