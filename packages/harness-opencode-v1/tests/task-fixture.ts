// SPDX-License-Identifier: LGPL-3.0-only
import type { HelperSummary } from "@otk/protocol";
import type { RawPart } from "../types.ts";
export const task: RawPart = {
  id: "part",
  sessionID: "parent",
  messageID: "message",
  type: "tool",
  tool: "task",
  callID: "call",
  state: {
    status: "completed",
    input: { description: "Inspection", subagent_type: "general" },
    output: "Native result",
    metadata: { sessionId: "child" },
    time: { start: 1, end: 5 },
  },
};
export const ready: HelperSummary = {
  state: "ready",
  revision: 2,
  toolCount: 1,
  current: { name: "bash", title: "Current changed" },
  time: { start: 1, end: 20 },
};
