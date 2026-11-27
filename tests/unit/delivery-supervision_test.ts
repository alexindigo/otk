// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionSupervision } from "../../core/index/supervision.ts";
import type { IndexMetadata } from "@otk/protocol";

const entry = (terminal = 100): IndexMetadata => ({
  id: "tstv1-child",
  parentID: "tstv1-parent",
  directory: "/project",
  title: "Helper",
  projectID: "repo",
  archived: false,
  timeCreated: 1,
  timeUpdated: terminal,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
  activity: { terminal, outcome: "succeeded" },
});
Deno.test("delivery acknowledges its covered terminal for every user, not future work", () => {
  const owner = new SessionSupervision(), row = entry();
  assertEquals(owner.session(row, 0).unseen, true);
  row.activity!.delivered = {
    parentID: row.parentID!,
    receipt: "result:1",
    terminal: 100,
  };
  assertEquals(owner.session(row, 0).unseen, false);
  assertEquals(owner.session(row, 50).state, "none");
  row.activity!.work = { keys: ["run:2"], fresh: true };
  assertEquals(owner.session(row, 0).state, "working");
  row.activity!.terminal = 200;
  assertEquals(owner.session(row, 0).unseen, true);
  row.activity!.work = undefined;
  assertEquals(owner.session(row, 0).state, "finishedUnseen");
});
Deno.test("receipt before terminal, wrong relationship, later user seen and failure history", () => {
  const owner = new SessionSupervision(), row = entry();
  row.activity!.outcome = "failed";
  row.activity!.delivered = {
    parentID: "tstv1-wrong",
    receipt: "result:1",
    terminal: 100,
  };
  assertEquals(owner.session(row, 0).unseen, true);
  row.activity!.delivered.parentID = row.parentID!;
  row.activity!.terminal = 50;
  assertEquals(owner.session(row, 0).unseen, true);
  assertEquals(owner.session(row, 0).state, "needsYou");
  row.activity!.terminal = undefined;
  assertEquals(owner.session(row, 0).unseen, false);
  row.activity!.terminal = 100;
  // D81: matched delivery covers the exact failed run without losing history.
  assertEquals(owner.session(row, 0).unseen, false);
  assertEquals(owner.session(row, 0).state, "none");
  assertEquals(owner.session(row, 0).outcome, "failed");
  assertEquals(owner.session(row, 100).state, "none");
  assertEquals(owner.session(row, 200, 200).unseen, false);
});

Deno.test("D58: a future receipt never covers an older uncovered run", () => {
  const owner = new SessionSupervision(), row = entry();
  row.activity!.delivered = {
    parentID: row.parentID!,
    receipt: "result:2",
    terminal: 200,
  };
  assertEquals(owner.session(row, 0).state, "finishedUnseen");
});
