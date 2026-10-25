// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { CommandHub } from "../mod.ts";

Deno.test("confirmation is projected as data from captured command args", async () => {
  const hub = new CommandHub(), calls: string[] = [];
  hub.register({
    id: "delete",
    title: "Delete",
    category: "Session",
    context: {
      kind: "session",
      confirm: (data: { id: string }) => `Press again to delete ${data.id}`,
    },
    run: (_ctx, data: { id: string }) => {
      calls.push(data.id);
    },
  });
  const action =
    hub.contextActions({ kind: "session", data: { id: "target" } })[0];
  assertEquals(action.confirm, "Press again to delete target");
  assertEquals(calls, []);
  await hub.runContext(action);
  assertEquals(calls, ["target"]);
});
