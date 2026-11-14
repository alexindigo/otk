// SPDX-License-Identifier: LGPL-3.0-only
import { mapTool as v1Tool, type RawPart } from "@otk/harness-opencode-v1";
import { mapTool as v2Tool } from "@otk/harness-opencode-v2-server";
import { TurnTimingAccumulator } from "@otk/harness";
import {
  type AssistantMessage,
  type Part,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";

/** Both native dialects project identical recorded intervals into one reply. */
export function segmentTimingFixture(
  sessionID: string,
  version: string,
  start: number,
) {
  const tool = (
    id: string,
    began: number,
    end: number,
    question = false,
  ): Part => {
    const name = question ? "question" : "read";
    const call = version.startsWith("1.")
      ? v1Tool({
        id,
        messageID: "segment-call",
        sessionID: "fixture",
        type: "tool",
        tool: name,
        callID: id,
        state: {
          status: "completed",
          input: { filePath: `/fixture/${id}.ts` },
          output: "ok",
          time: { start: start + began, end: start + end },
        },
      } as RawPart)
      : v2Tool({
        type: "tool",
        id,
        name,
        state: {
          status: "completed",
          input: { path: `/fixture/${id}.ts` },
          content: [{ type: "text", text: "ok" }],
          metadata: {},
        },
        time: {
          created: start + began,
          ran: start + began,
          completed: start + end,
        },
      });
    return { kind: "tool", id, call };
  };
  const parts: Part[] = [
    tool("segment-read-a", 0, 400),
    tool("segment-read-b", 200, 700),
    {
      kind: "text",
      id: "segment-text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{
          i: "text",
          text:
            "The first work log contains overlapping reads. The next work log excludes the recorded question wait. Each header measures only its own segment.",
        }],
      }],
    },
    tool("segment-read-c", 1000, 2200),
    tool("segment-question", 1200, 1500, true),
  ];
  const message: AssistantMessage = {
    id: "segment-call",
    sessionID,
    role: "assistant",
    replyTo: "segment-turn",
    sourceOrder: 200,
    agent: "junior",
    model: { provider: "fake", model: "scripted" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    time: { created: start, completed: start + 2200 },
    parts,
  };
  const owner = new TurnTimingAccumulator();
  owner.add({
    start,
    end: start + 2200,
    terminal: true,
    source: "recorded-segment-fixture",
    busy: [{ start, end: start + 700 }, {
      start: start + 1000,
      end: start + 2200,
    }],
    waits: [{ start: start + 1200, end: start + 1500 }],
  });
  return {
    message,
    summary: {
      ...new UsageLedger(sessionID, [usageHeader(message)]).summary(
        "segment-turn",
      )!,
      timing: owner.result(),
    },
  };
}
