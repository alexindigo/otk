// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTaskActions } from "@otk/client";
Deno.test("task action editors retain the owning RPC connection and directory", async () => {
  const calls: unknown[] = [];
  const actions = createTaskActions({
    call(method, params) {
      calls.push([method, params]);
      return Promise.resolve({
        id: "t",
        directory: "/owner",
        name: "Plan",
        order: 0,
        sessions: [],
      }) as never;
    },
  }, "/owner");
  const task = await actions.create("Plan");
  await actions.rename(task.id, "Build");
  await actions.reorder([task.id]);
  await actions.add(task, "s");
  await actions.remove(task, "s");
  await actions.close(task.id);
  assertEquals(calls, [
    ["tasks.create", { directory: "/owner", name: "Plan" }],
    ["tasks.rename", { id: "t", name: "Build" }],
    ["tasks.reorder", { directory: "/owner", ids: ["t"] }],
    ["tasks.addSession", { id: "t", sessionID: "s" }],
    ["tasks.removeSession", { id: "t", sessionID: "s" }],
    ["tasks.close", { id: "t" }],
  ]);
});
