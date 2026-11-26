// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { entityKey, type IndexMetadata } from "@otk/protocol";
import { EntityStates } from "../../../core/index/entity-states.ts";
import { SessionSupervision } from "../../../core/index/supervision.ts";
import { ManualClock } from "../../support/manual-clock.ts";

Deno.test("server permission deadlines publish one verdict to the session, task and project", () => {
  const clock = new ManualClock();
  const root: IndexMetadata = {
    id: "root",
    directory: "/p",
    projectID: "p",
    title: "Root",
    archived: false,
    status: "idle",
    timeCreated: 0,
    timeUpdated: 0,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const states = new EntityStates(
    new SessionSupervision(),
    {
      getMetadata: (id) => id === root.id ? root : undefined,
      ancestors: (id) => id === "helper" ? [root.id] : [],
      descendants: (id) => new Set(id === root.id ? [id, "helper"] : [id]),
    },
    () => {},
    clock,
  );
  const put = (...keys: string[]) =>
    states.session({
      ...root,
      id: "helper",
      parentID: root.id,
      activity: {
        work: { keys: ["run"], fresh: true },
        permissions: { keys, fresh: true },
      },
    }, 0);
  const session = () => states.get(entityKey("session", "helper"));
  const task = () => states.get(entityKey("task", "session/root"));
  const project = () => states.get(entityKey("project", "/p"));
  states.project("/p", ["/p"]);
  states.session(root, 0);
  states.member("helper", "/p");
  put("old");
  assertEquals(session()?.state, "working");
  assertEquals(task()?.helpers?.counts, {
    running: 1,
    needsYou: 0,
    finished: 0,
  });
  clock.advanceTo(400);
  put("new");
  clock.advanceTo(500);
  assertEquals(session()?.state, "working");
  clock.advanceTo(899);
  assertEquals(project()?.state, "working");
  clock.advanceTo(900);
  assertEquals(session()?.state, "blocked");
  assertEquals(task()?.state, "blocked");
  assertEquals(task()?.helpers?.counts, {
    running: 0,
    needsYou: 1,
    finished: 0,
  });
  assertEquals(project()?.state, "blocked");
  put();
  assertEquals(project()?.state, "working");
  assertEquals(clock.pending, 0);
});
