// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, FileDiff, Message } from "@otk/protocol";

const file: FileDiff = {
  path: "/project/main.ts",
  status: "modified",
  additions: 2,
  deletions: 2,
  hunks: [{
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [
      { kind: "context", text: "// keep", oldNo: 1, newNo: 1 },
      { kind: "del", text: "const oldValue = 1;", oldNo: 2 },
      { kind: "add", text: "const newValue = 2;", newNo: 2 },
    ],
  }, {
    oldStart: 10,
    oldLines: 1,
    newStart: 10,
    newLines: 1,
    lines: [
      { kind: "del", text: "const previous = true;", oldNo: 10 },
      { kind: "add", text: "const current = true;", newNo: 10 },
    ],
  }],
};
const reply: AssistantMessage = {
  id: "reply",
  sessionID: "tstv1-otk",
  replyTo: "prompt",
  role: "assistant",
  agent: "build",
  model: { provider: "fixture", model: "model" },
  time: { created: 2, completed: 3 },
  tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  parts: [
    {
      id: "answer",
      kind: "text",
      synthetic: false,
      blocks: [
        { b: "paragraph", inline: [{ i: "text", text: "Reply source" }] },
        { b: "code", text: "const answer = 42;\n", lang: "typescript" },
      ],
    },
    {
      id: "bash",
      kind: "tool",
      call: {
        tool: "bash",
        callID: "bash",
        command: "printf context-output",
        output: "context-output",
        status: "completed",
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "read",
      kind: "tool",
      call: {
        tool: "read",
        callID: "read",
        path: "/project/source.txt",
        loaded: [],
        output: "Read output",
        status: "completed",
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "edit",
      kind: "tool",
      call: {
        tool: "edit",
        callID: "edit",
        path: file.path!,
        files: [file],
        output: "",
        diagnostics: [],
        status: "completed",
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "patch",
      kind: "tool",
      call: {
        tool: "patch",
        callID: "patch",
        files: [file, { ...file, path: "/project/other.ts" }],
        output: "",
        status: "completed",
        time: { start: 2, end: 3 },
      },
    },
  ],
};
export const menusMessages: Message[] = [
  {
    id: "prompt",
    sessionID: "tstv1-otk",
    role: "user",
    time: { created: 1 },
    parts: [{
      id: "input",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Prompt source" }],
      }],
    }],
  },
  reply,
  {
    ...reply,
    id: "reply-followup",
    time: { created: 4, completed: 5 },
    parts: [{
      id: "followup-text",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Second reply step" }],
      }],
    }],
  },
];
