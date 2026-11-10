// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { pendingAttention } from "../attention.ts";
Deno.test("V2 pending projection routes each request through its complete ancestor path without double counting", () => {
  const entries = {
    child: { parentID: "parent" },
    parent: { parentID: "root" },
    root: {},
  };
  const lookup = (id: string) => entries[id as keyof typeof entries];
  const requests = [{ sessionID: "child", kind: "permission" as const }, {
    sessionID: "child",
    kind: "form" as const,
    stale: true,
  }];
  assertEquals(pendingAttention("child", requests, lookup), {
    attention: {
      permissions: 1,
      questions: 1,
      childPermissions: 0,
      childQuestions: 0,
    },
    stale: true,
  });
  for (const id of ["parent", "root"]) {
    assertEquals(pendingAttention(id, requests, lookup), {
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 1,
        childQuestions: 1,
      },
      stale: true,
    });
  }
  assertEquals(pendingAttention("other", requests, lookup).attention, {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  });
});
