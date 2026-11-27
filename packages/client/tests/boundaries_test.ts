// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Activity, Message, Part } from "@otk/protocol";
import { boundaryActivity, boundaryKey, sessionBoundary } from "../mod.ts";

const activity: Activity = {
  kindLabel: "Notice",
  title: "Opaque producer title",
  layout: "boundary",
  category: "record",
  tone: "normal",
};
const part: Part = { kind: "external", name: "notice", id: "part", activity };
const context: Message = {
  id: "message",
  role: "context",
  sessionID: "session",
  time: { created: 1 },
  parts: [{ kind: "meta", id: "meta" }, part],
};

Deno.test("only producer-declared external boundary parts in context form session boundaries", () => {
  assertEquals(boundaryActivity(part), activity);
  assertEquals(boundaryKey(part), "part");
  assertEquals(sessionBoundary(context), { part, key: "part" });
  assertEquals(sessionBoundary({ ...context, parts: [] }), undefined);
  for (const direction of [undefined, "outgoing"] as const) {
    const row: Part = {
      ...part,
      activity: { ...activity, direction, layout: "row" },
    };
    assertEquals(boundaryActivity(row), undefined);
    assertEquals(sessionBoundary({ ...context, parts: [row] }), undefined);
  }
  assertEquals(sessionBoundary({ ...context, role: "user" }), undefined);
  assertEquals(
    sessionBoundary({
      ...context,
      role: "assistant",
      agent: "build",
      cost: 0,
      interrupted: false,
      model: { provider: "test", model: "test" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
    undefined,
  );
});
