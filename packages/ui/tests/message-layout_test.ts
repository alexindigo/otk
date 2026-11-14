// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { Part, UserMessage } from "@otk/protocol";
import {
  createMessageLayout,
  messageFrames,
  messageLayoutRole,
} from "../components/work-log.ts";

Deno.test("segment timing follows cached part evidence across clock updates and unknown endpoints", () => {
  const owner = createMessageLayout();
  let presented = 0;
  const part = (id: string, end?: number): Part => ({
    kind: "reasoning",
    id,
    blocks: [],
    time: { start: 100, end },
  });
  const first = part("first", 500), text: Part = { kind: "meta", id: "text" };
  const present = (p: Part) => {
    presented++;
    return p.kind === "reasoning" ? { work: p.time, timing: p.time } : {};
  };
  const update = (last: Part) =>
    owner.update(
      "reply",
      "assistant",
      [{
        messageID: "source",
        parts: [first, text, last],
      }],
      "prefs",
      present,
    );
  assertEquals(
    update(part("last", 1000)).frames[0].groups.map((g) => g.workingMs),
    [400, undefined, 900],
  );
  assertEquals(presented, 3);
  assertEquals(
    update(part("last", 1300)).frames[0].groups.map((g) => g.workingMs),
    [400, undefined, 1200],
  );
  assertEquals(presented, 4);
  assertEquals(update(part("last")).frames[0].groups.map((g) => g.workingMs), [
    400,
    undefined,
    undefined,
  ]);
  assertEquals(presented, 5);
});

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

Deno.test("live failure presentation rebuilds the enclosing work group's required contract", () => {
  const owner = createMessageLayout();
  const part = (failed: boolean): Part => ({
    id: "result",
    kind: "external",
    name: "fixture/result",
    data: failed ? "failed" : "completed",
  });
  const present = (value: Part) => ({
    work: { start: 1, end: 2 },
    required: value.kind === "external" && value.data === "failed",
  });
  for (const failed of [false, true, false]) {
    const layout = owner.update(
      "reply",
      "assistant",
      [{
        messageID: "source",
        parts: [part(failed)],
      }],
      "prefs",
      present,
    );
    assertEquals(layout.frames[0].groups[0].required ?? false, failed);
    assertEquals(layout.frames[0].groups[0].parts.length, 1);
  }
});

Deno.test("bookkeeping after reply text keeps its own fold across reload and required changes", () => {
  const make = (required: boolean) =>
    [
      { id: "start", kind: "meta" },
      { id: "reasoning", kind: "meta" },
      { id: "answer", kind: "meta" },
      {
        id: "finish",
        kind: "external",
        name: "fixture/end",
        data: String(required),
      },
    ] as Part[];
  const present = (part: Part) => ({
    work: part.id === "answer" ? undefined : {},
    required: part.kind === "external" && part.data === "true",
  });
  const shape = (
    owner: ReturnType<typeof createMessageLayout>,
    required: boolean,
  ) =>
    owner.update(
      "reply",
      "assistant",
      [{ messageID: "source", parts: make(required) }],
      "prefs",
      present,
    )
      .frames[0].groups.map((group) => ({
        id: group.id,
        parts: group.parts.map((part) => part.id),
        work: group.work,
        required: !!group.required,
      }));
  const owner = createMessageLayout();
  const initial = shape(owner, false);
  assertEquals(initial, [
    { id: "start", parts: ["start", "reasoning"], work: true, required: false },
    { id: "answer", parts: ["answer"], work: false, required: false },
    { id: "finish", parts: ["finish"], work: true, required: false },
  ]);
  const failed = shape(owner, true);
  assertEquals(
    failed.map(({ required: _required, ...group }) => group),
    initial.map(({ required: _required, ...group }) => group),
  );
  assertEquals(failed.map((group) => group.required), [false, false, true]);
  assertEquals(shape(owner, false), initial);
  assertEquals(shape(createMessageLayout(), false), initial);
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
