// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type {
  Activity,
  ContentOp,
  ContextMessage,
  Part,
  ToolCall,
  ToolResult,
} from "@otk/protocol";
import { isRealPrompt } from "@otk/protocol";

const activity: Activity = {
  kindLabel: "Flux",
  layout: "row",
  category: "record",
  tone: "normal",
  title: "Flux settled",
  detail: "An unfamiliar outcome",
  direction: "outgoing",
  state: {
    key: "unfathomable",
    label: "Unfathomable",
    facts: { active: null, terminal: null },
  },
  parameters: [{
    key: "job",
    label: "Job",
    value: "42",
    child: { sessionID: "acmv1-child", label: "Child" },
  }],
  body: [{
    b: "paragraph",
    inline: [{ i: "strong", inline: [{ i: "text", text: "Full response" }] }],
  }],
  child: { sessionID: "acmv1-child", label: "Child" },
  icon: { name: "flux", label: "Flux" },
};

Deno.test("neutral activity survives the content-operation JSON wire with unknown facts and exact source", () => {
  const message: ContextMessage = {
    id: "context",
    sessionID: "acmv1-session",
    role: "context",
    sourceOrder: 7,
    time: { created: 12 },
    parts: [{
      kind: "external",
      id: "part",
      name: "acme/flux",
      activity,
      source: {
        kind: "acme/flux",
        preview: "bounded",
        bytes: 90,
        truncated: true,
        payload: "  <flux>\n**Full response**\n</flux>\n",
      },
    }],
    revert: { messageID: "context", affected: { messages: 3, prompts: 1 } },
  };
  const op: ContentOp = { op: "message.upsert", message };
  const decoded: ContentOp = JSON.parse(JSON.stringify(op));
  assertEquals(decoded, op);
  assertEquals(isRealPrompt(message), false);
  assertEquals("hidden" in activity, false);
});

Deno.test("typed parts and calls retain native source beside rendered block results", () => {
  const source = {
    kind: "acme/prose",
    preview: "preview",
    bytes: 8,
    truncated: false,
    payload: "**bold**",
  };
  const part: Part = {
    kind: "text",
    id: "typed",
    blocks: [],
    synthetic: false,
    source,
  };
  const outputContent: ToolResult = { kind: "blocks", blocks: activity.body! };
  const call: ToolCall = {
    tool: "task",
    callID: "call",
    description: "Flux",
    status: "completed",
    time: {},
    source,
    outputContent,
  };
  assertEquals(JSON.parse(JSON.stringify({ part, call })), { part, call });
});
