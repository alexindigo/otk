// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTranscriptProjection } from "../transcript-projection.ts";
import type { UserMessage } from "@otk/protocol";

const message = (id = "msg_send"): UserMessage => ({
  id,
  sessionID: "opcv2-session",
  role: "user",
  time: { created: 10 },
  parts: [{
    id: "local:text",
    kind: "text",
    synthetic: false,
    blocks: [{ b: "paragraph", inline: [{ i: "text", text: "Hello" }] }],
  }],
});
const intent = { clientID: "tab", key: "send-request", window: "window" };

Deno.test("send immediately owns one pending entry then commits that same identity", () => {
  const p = createTranscriptProjection();
  p.send({ intent, message: message(), phase: "pending" });
  const keys = p.state.replyIDs;
  assertEquals(keys.length, 1);
  assertEquals(p.state.repliesByID[keys[0]].send?.phase, "pending");
  p.apply({
    op: "message.upsert",
    message: { ...message(), time: { created: 20 } },
  });
  assertEquals(p.state.replyIDs, keys);
  assertEquals(p.state.repliesByID[keys[0]].send?.phase, "committed");
  assertEquals(p.state.messagesByID.msg_send.sourceOrder, 0);
});

Deno.test("failure and explicit Retry update the same transcript entry", () => {
  const p = createTranscriptProjection();
  const entry = { intent, message: message(), phase: "pending" as const };
  p.send(entry);
  p.send({
    ...entry,
    phase: "failed",
    feedback: { kind: "error", text: "Unavailable" },
  });
  assertEquals(p.entry("msg_send")?.send?.phase, "failed");
  p.send(entry);
  assertEquals(p.state.replyIDs, [intent.key]);
  assertEquals(p.entry("msg_send")?.send?.phase, "pending");
});

Deno.test("reconnect replacement preserves unresolved sends and reconciles native before acknowledgement", () => {
  const p = createTranscriptProjection();
  p.send({ intent, message: message(), phase: "pending" });
  p.replace([message("other")]);
  assertEquals(p.state.replyIDs.includes(intent.key), true);
  p.replace([{ ...message(), parts: [] }]);
  assertEquals(p.state.replyIDs, [intent.key]);
  assertEquals(p.entry("msg_send")?.send?.phase, "committed");
  assertEquals(p.state.messagesByID.msg_send.parts.length, 1);
  p.apply({
    op: "part.upsert",
    messageID: "msg_send",
    part: { ...message().parts[0], id: "native:text" },
  });
  assertEquals(p.state.messagesByID.msg_send.parts.map((p) => p.id), [
    "native:text",
  ]);
});

Deno.test("local sends retain native sequence-space placement and their own causal replies", () => {
  const p = createTranscriptProjection();
  p.replace([{ ...message("earlier"), sourceOrder: 40 }]);
  p.send({ intent, message: message(), phase: "pending" });
  const second = { ...intent, key: "next-send" };
  p.send({ intent: second, message: message("next"), phase: "pending" });
  p.apply({ op: "message.upsert", message: { ...message(), sourceOrder: 41 } });
  p.apply({
    op: "message.upsert",
    message: {
      id: "reply",
      sessionID: "opcv2-session",
      role: "assistant",
      replyTo: "msg_send",
      sourceOrder: 42,
      time: { created: 20, completed: 21 },
      model: { provider: "test", model: "test" },
      agent: "build",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    },
  });
  assertEquals(p.state.replyIDs, [
    "earlier",
    intent.key,
    "reply:msg_send",
    second.key,
  ]);
  p.apply({
    op: "message.upsert",
    message: { ...message("next"), sourceOrder: 43 },
  });
  assertEquals(p.state.replyIDs, [
    "earlier",
    intent.key,
    "reply:msg_send",
    second.key,
  ]);
});

Deno.test("cooling retains unresolved input but retires committed send bodies with their source", () => {
  const p = createTranscriptProjection();
  p.send({ intent, message: message(), phase: "pending" });
  p.retain(new Set());
  assertEquals(p.state.replyIDs, [intent.key]);
  p.apply({ op: "message.upsert", message: message() });
  p.retain(new Set());
  assertEquals(p.state.replyIDs, []);
  p.replace([message()]);
  assertEquals(p.state.replyIDs, ["msg_send"]);
  assertEquals(p.entry("msg_send")?.send, undefined);
});
