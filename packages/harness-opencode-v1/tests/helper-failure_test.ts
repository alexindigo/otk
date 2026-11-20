// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { recordPart } from "../records.ts";

Deno.test("V1 task_error is a public helper failure, not hidden result prose", () => {
  const part = recordPart({
    id: "part_helper",
    messageID: "msg_helper",
    sessionID: "ses_parent",
    type: "text",
    synthetic: true,
    text:
      '<task id="ses_child" state="error">\n<summary>SD store</summary>\n<task_error>\nUsage limit reached\n</task_error>\n</task>',
  });
  assertEquals(part.activity?.summary?.plural, "helpers failed");
  assertEquals(part.failure?.facts?.reason, "Usage limit reached");
  assertEquals(part.failure?.facts?.target?.sessionID, "opcv1-ses_child");
  assertEquals(
    part.failure?.facts?.recovery,
    "Check your provider credits or usage limits, then retry the task.",
  );
});
