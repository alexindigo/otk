// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SelectionIntents } from "../selection-intent.ts";
import type { RawPart } from "../types.ts";

const result = (tool = "plan_exit"): RawPart => ({
  id: "p",
  sessionID: "s",
  messageID: "m",
  type: "tool",
  tool,
  callID: "c",
  state: {
    status: "completed",
    input: {},
    title: "Switching to build agent",
    output:
      "User approved switching to build agent. Wait for further instructions.",
    time: { start: 10, end: 30 },
  },
});
Deno.test("selection intent requires the native synthetic user fact, not a tool name", () => {
  const owner = new SelectionIntents();
  assertEquals(owner.part(result()), undefined);
  owner.header({
    id: "u",
    sessionID: "s",
    role: "user",
    agent: "build",
    time: { created: 20 },
  });
  assertEquals(owner.part(result()), undefined);
  owner.part({
    id: "text",
    sessionID: "s",
    messageID: "u",
    type: "text",
    synthetic: true,
    text:
      "The plan at .opencode/plans/example.md has been approved, you can now edit files. Execute the plan",
  });
  assertEquals(owner.part(result()), { agent: "build" });
  owner.release("s");
  assertEquals(owner.part(result()), undefined);
});
Deno.test("selection provenance fences denied results, foreign identities and unrelated synthetic text", () => {
  const owner = new SelectionIntents();
  owner.header({
    id: "u",
    sessionID: "s",
    role: "user",
    agent: "build",
    time: { created: 20 },
  });
  owner.part({
    id: "text",
    sessionID: "s",
    messageID: "u",
    type: "text",
    synthetic: true,
    text: "Unrelated reminder",
  });
  assertEquals(owner.part(result()), undefined);
  owner.part({
    id: "text",
    sessionID: "s",
    messageID: "u",
    type: "text",
    synthetic: true,
    text:
      "The plan at plan.md has been approved, you can now edit files. Execute the plan",
  });
  const denied = result();
  denied.state!.status = "error";
  assertEquals(owner.part(denied), undefined);
  const foreign = result();
  foreign.sessionID = "other";
  assertEquals(owner.part(foreign), undefined);
  const old = result();
  old.state!.time = { start: 21, end: 30 };
  assertEquals(owner.part(old), undefined);
});
