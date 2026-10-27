// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { HarnessSink } from "@otk/harness";
import { connectionPublication } from "../publication.ts";

Deno.test("connection publication ports permanently drop every publication after their own abort", () => {
  const calls: string[] = [], controller = new AbortController();
  const target: HarnessSink = {
    connection: () => calls.push("connection"),
    indexReset: () => calls.push("reset"),
    indexUpsert: () => calls.push("upsert"),
    indexRemove: () => calls.push("remove"),
    content: () => calls.push("content"),
    resync: () => calls.push("resync"),
  };
  const old = connectionPublication(target, controller.signal);
  const publish = (sink: HarnessSink) => {
    sink.connection("connected");
    sink.indexReset([]);
    sink.indexRemove("s");
    sink.indexUpsert({
      id: "s",
      projectID: "p",
      directory: "/p",
      title: "s",
      archived: false,
      status: "idle",
      timeCreated: 1,
      timeUpdated: 1,
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    });
    sink.content("s", { op: "todo.set", items: [] });
    sink.resync("all");
  };
  publish(old);
  assertEquals(calls.length, 6);
  controller.abort();
  const replacement = connectionPublication(
    target,
    new AbortController().signal,
  );
  publish(old);
  assertEquals(calls.length, 6);
  publish(replacement);
  assertEquals(calls.length, 12);
  publish(old);
  assertEquals(calls.length, 12);
});
