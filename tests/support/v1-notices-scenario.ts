// SPDX-License-Identifier: LGPL-3.0-only
import {
  eventRecord,
  type Info,
  mapMessage,
  type RawPart,
} from "@otk/harness-opencode-v1";
import { fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

export async function v1NoticesScenario() {
  const root = await fixture(), sessionID = "tstv1-otk";
  const base = {
    sessionID: "fixture",
    role: "user" as const,
    time: { created: 1000 },
  };
  const part = (id: string, text: string, synthetic = false): RawPart => ({
    id,
    sessionID: "fixture",
    messageID: "prompt",
    type: "text",
    text,
    synthetic,
  });
  const failure = "The usage limit has been reached";
  const raw: { info: Info; parts: RawPart[] }[] = [
    {
      info: { ...base, id: "context" },
      parts: [part("standalone", "Context prepared by the harness", true)],
    },
    {
      info: { ...base, id: "prompt", time: { created: 2000 } },
      parts: [
        part("question", "Please investigate the native record history."),
        part("expansion", "**Attached context** belongs to this prompt.", true),
      ],
    },
    {
      info: {
        id: "reply",
        sessionID: "fixture",
        role: "assistant",
        parentID: "prompt",
        agent: "build",
        providerID: "fake",
        modelID: "scripted",
        time: { created: 3000, completed: 4000 },
        error: { name: "APIError", data: { message: failure } },
      },
      parts: [{
        id: "task",
        sessionID: "fixture",
        messageID: "reply",
        type: "tool",
        tool: "task",
        callID: "task-call",
        state: {
          status: "error",
          input: {
            subagent_type: "junior",
            description: "Inspect retained records",
          },
          error: `Subagent failed: ${failure}`,
          time: { start: 3100, end: 3900 },
        },
      }],
    },
    {
      info: { ...base, id: "task-notice", time: { created: 4500 } },
      parts: [
        part(
          "delivered-task",
          `<task id="child" state="error">\n<summary>Background task failed: Inspect retained records</summary>\n<task_error>\n${failure}\n</task_error>\n</task>`,
          true,
        ),
      ],
    },
    {
      info: {
        id: "summary",
        sessionID: "fixture",
        role: "assistant",
        parentID: "marker",
        summary: true,
        agent: "compaction",
        providerID: "fake",
        modelID: "scripted",
        time: { created: 5000, completed: 6000 },
      },
      parts: [
        part(
          "summary-body",
          "## Retained summary\n\nThe complete compaction summary remains inspectable.",
        ),
      ],
    },
  ];
  const messages = raw.map(({ info, parts }) => ({
    ...mapMessage(info, parts),
    sessionID,
  }));
  messages.push(...[
    eventRecord("fixture", "permission:retained", 6500, "permission.replied", {
      requestID: "retained",
      reply: "reject",
    }, {
      permission: "bash",
      patterns: ["git status --short"],
      metadata: { command: "git status --short" },
    }),
    eventRecord("fixture", "question:retained", 7000, "question.rejected", {
      requestID: "retained",
    }, {
      questions: [{
        header: "Verification",
        question: "Run the focused checks?",
      }],
    }),
    eventRecord("fixture", "retry:retained", 7500, "session.retry", {
      attempt: 1,
      message: "Free usage exceeded, subscribe to Go",
      next: 8000,
      action: {
        reason: "free_tier_limit",
        provider: "fixture",
        title: "Free limit reached",
        message: "Subscribe to continue",
        label: "subscribe",
        link: "https://opencode.ai/go",
      },
    }),
  ].map((message) => ({ ...message, sessionID })));
  const f = await inboxBrowserFixture(root, [], { [sessionID]: messages });
  const client = new WsClient(f.url);
  await client.connect(f.entries[0].directory);
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  let lease: TestLease | undefined;
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign V1-notices lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { frames: client.frames };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "stop":
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside V1-notices scenario");
      }
    },
  };
}
