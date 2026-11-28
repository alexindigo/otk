// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { Part, UserMessage } from "@otk/protocol";
import {
  createMessageLayout,
  messageFrames,
  messageLayoutRole,
  workRuns,
} from "../components/work-log.ts";

Deno.test("work revisions do not remount the prose segment", () => {
  const owner = createMessageLayout();
  const text: Part = { kind: "meta", id: "text" };
  const present = (part: Part) =>
    part.kind === "reasoning"
      ? {
        work: part.time,
        run: { label: "Thought", lane: "thinking" as const },
      }
      : {};
  const parts = (end?: number): Part[] => [text, {
    kind: "reasoning",
    id: "thought",
    blocks: [],
    time: { start: 100, end },
  }];
  const update = (source: Part[]) =>
    owner.update(
      "reply",
      "assistant",
      [{ messageID: "source", parts: source }],
      "prefs",
      present,
    );
  const before = update(parts(700)).frames[0].groups[0];
  for (
    const [end, weight] of [[700, 600], [1600, 1500], [undefined, 0]] as const
  ) {
    const source = parts(end);
    const next = update(source).frames[0].groups;
    assertEquals(next.map(({ id }) => id), ["text"]);
    assertStrictEquals(next[0], before);
    assertEquals(
      workRuns({
        parts: source,
        presentation: present,
        terminal: true,
        now: 2000,
      }).segments[0].weightMs,
      weight,
    );
  }
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

Deno.test("failed work stays in the work projection rather than the prose frames", () => {
  const owner = createMessageLayout();
  const answer: Part = { id: "answer", kind: "meta" };
  const present = (part: Part) =>
    part.id === "answer" ? {} : {
      work: { start: 1, end: 2 },
      required: part.kind === "external" && part.data === "failed",
    };
  for (const failed of [false, true, false]) {
    const result: Part = {
      id: "result",
      kind: "external",
      name: "fixture/result",
      data: failed ? "failed" : "completed",
    };
    const parts = [answer, result];
    const layout = owner.update(
      "reply",
      "assistant",
      [{ messageID: "source", parts }],
      "prefs",
      present,
    );
    assertEquals(layout.frames[0].groups.flatMap((group) => group.parts), [
      answer,
    ]);
    assertEquals(
      workRuns({ parts, terminal: true, now: 3, presentation: present }).failed
        .length,
      Number(failed),
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
  assertEquals(after.frames[0].groups.length, 102);
  const extended = owner.update(
    "reply",
    "assistant",
    [{ messageID: "prefix", parts: [part("work-prefix")] }, ...next],
    "prefs",
    present,
  );
  assertEquals(extended.frames[0].groups.length, 102);
  assertEquals(extended.frames[0].groups[0].id, historical.id);
  assertEquals(
    extended.frames[0].groups[101].id,
    after.frames[0].groups[101].id,
  );
});

Deno.test("reply metadata carries one fact per agent, including tool-only calls", () => {
  const owner = createMessageLayout();
  const calls = [...Array<string>(20).fill("build"), "plan", "build"].map(
    (agent, i) => ({
      messageID: `call-${i}`,
      agent,
      time: { created: i },
      parts: [{ kind: "meta" as const, id: `part-${i}` }],
    }),
  );
  const facts = owner.update(
    "reply",
    "assistant",
    calls,
    "prefs",
    (part) => part.id === "part-0" ? { prose: true } : { work: {} },
  );
  assertEquals(
    facts.replyAgents.map(({ agent, messageID }) => [agent, messageID]),
    [
      ["build", "call-0"],
      ["plan", "call-20"],
    ],
  );
});
