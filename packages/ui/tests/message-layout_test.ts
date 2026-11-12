// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { Part, UserMessage } from "@otk/protocol";
import {
  createMessageLayout,
  messageFrames,
  messageLayoutRole,
} from "../components/work-log.ts";

Deno.test("provider context never shares user bubbles or actionable prompt identity", () => {
  const message: UserMessage = {
    id: "context",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    parts: [{ kind: "meta", id: "summary" }],
  };
  const present = () => ({ text: "summary", copyable: true });
  assertEquals(messageFrames(message, present).prompt, true);
  assertEquals(
    Reflect.get(messageFrames(message, present), "userBubble"),
    true,
  );
  for (
    const origin of [
      "compaction",
      "shell",
      "synthetic",
      "system",
      "skill",
      "external",
    ] as const
  ) {
    const contextual: UserMessage = { ...message, origin };
    const frames = messageFrames(contextual, present);
    const layout = createMessageLayout().update(
      contextual.id,
      messageLayoutRole(contextual),
      [{ messageID: contextual.id, parts: contextual.parts }],
      "prefs",
      present,
    );
    assertEquals(frames.prompt, false);
    assertEquals(layout.prompt, false);
    assertEquals(Reflect.get(frames, "userBubble"), false);
    assertEquals(Reflect.get(layout, "userBubble"), false);
    const markers = () => ({ frame: "transcript" as const });
    assertEquals(
      Reflect.get(messageFrames(contextual, markers), "userBubble"),
      false,
    );
    assertEquals(
      Reflect.get(
        createMessageLayout().update(
          contextual.id,
          messageLayoutRole(contextual),
          [{ messageID: contextual.id, parts: contextual.parts }],
          "prefs",
          markers,
        ),
        "userBubble",
      ),
      false,
    );
  }
});

Deno.test("render layout reprojects only changed source parts and keeps historical groups stable", () => {
  const part = (id: string): Part => ({ id, kind: "meta" });
  const segments = Array.from(
    { length: 102 },
    (_, i) => ({
      messageID: `step-${i}`,
      parts: [part(`text-${i}`), part(`work-${i}`)],
    }),
  );
  let visits = 0;
  const present = (value: Part) => {
    visits++;
    return {
      work: value.id.startsWith("work") ? { start: 0 } : undefined,
      copyable: true,
    };
  };
  const owner = createMessageLayout();
  const before = owner.update("reply", "assistant", segments, "prefs", present);
  const historical = before.frames[0].groups[0];
  visits = 0;
  const next = [...segments];
  next[101] = {
    ...next[101],
    parts: [part("text-101"), segments[101].parts[1]],
  };
  const after = owner.update("reply", "assistant", next, "prefs", present);
  assertEquals(visits, 1);
  assertStrictEquals(after.frames[0].groups[0], historical);
  assertEquals(after.frames[0].groups.length, 204);
  const extended = owner.update(
    "reply",
    "assistant",
    [{ messageID: "prefix", parts: [part("work-prefix")] }, ...next],
    "prefs",
    present,
  );
  assertEquals(extended.frames[0].groups.length, 205);
  assertEquals(extended.frames[0].groups[1].id, historical.id);
});
