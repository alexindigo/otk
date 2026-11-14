// SPDX-License-Identifier: LGPL-3.0-only
import {
  mapMessage,
  type NativeMessage,
  Transcript,
} from "@otk/harness-opencode-v2-server";
import { cfg, fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
import type { Message } from "@otk/protocol";
export async function noticesScenario() {
  const root = await fixture(),
    sessionID = "tstv1-otk",
    limit = "The usage limit has been reached";
  const body =
    "**Result**\n\n| Check | Result |\n| --- | --- |\n| Records | Kept |";
  const raw: NativeMessage[] = [
    {
      id: "msg_system",
      type: "system",
      text: "Available tool catalog updated.",
      description: "Instructions updated: codemode",
      time: { created: 1000 },
    },
    {
      id: "msg_failed",
      type: "synthetic",
      text:
        `<subagent sessionID="ses_child" state="error" description="Inspect fixture">\n${limit}\n</subagent>`,
      description: "Inspect fixture",
      metadata: {
        source: "subagent",
        agent: "junior",
        state: "error",
        childID: "ses_child",
      },
      time: { created: 2000 },
    },
    {
      id: "msg_parent",
      type: "assistant",
      agent: "build",
      model: { id: "scripted", providerID: "fake" },
      content: [],
      error: { type: "provider.quota", message: limit },
      time: { created: 2100, completed: 2200 },
    },
    {
      id: "msg_result",
      type: "assistant",
      agent: "build",
      model: { id: "scripted", providerID: "fake" },
      time: { created: 2300, completed: 2400 },
      content: [
        {
          type: "tool",
          id: "delegate",
          name: "subagent",
          time: { created: 2300, completed: 2310 },
          state: {
            status: "completed",
            input: { agent: "junior", description: "Foreground result" },
            metadata: { sessionID: "ses_child", status: "completed" },
            content: [{
              type: "text",
              text:
                `<subagent sessionID="ses_child" state="completed">\n${body}\n</subagent>`,
            }],
          },
        },
        {
          type: "tool",
          id: "execute",
          name: "execute",
          time: { created: 2320, completed: 2330 },
          state: {
            status: "completed",
            input: { code: "await tools.read({ path: 'missing' })" },
            metadata: {
              error: true,
              toolCalls: [{
                tool: "read",
                status: "error",
                input: { path: "missing" },
              }],
            },
            content: [{ type: "text", text: "No such file: missing" }],
          },
        },
      ],
    },
    {
      id: "msg_shell",
      type: "shell",
      shellID: "sh_fixture",
      command: "exit 7",
      status: "exited",
      exit: 7,
      time: { created: 2500, completed: 2600 },
      output: {
        output: "Process output",
        size: 14,
        cursor: 14,
        truncated: false,
      },
    },
    {
      id: "msg_goal",
      type: "synthetic",
      text: "Goal continuation",
      time: { created: 2700 },
    },
  ];
  const messages = raw.map((m, order) =>
    mapMessage(m, sessionID, { order: order + 1 })
  );
  // Exercise the real retention/classification seam, not hand-authored outcome UI.
  const transcript = new Transcript({
    policy: cfg().messages,
    client: () => {
      throw new Error("No native read expected");
    },
    content(_id, op) {
      if (op.op === "message.upsert") {
        messages.push({ ...op.message, sessionID });
      }
    },
    diagnostic() {},
    invalidated() {},
  });
  transcript.subscriptions("opcv2-ses_fixture", 1);
  await transcript.event({
    type: "form.created",
    data: {
      form: {
        id: "frm_fixture",
        metadata: { kind: "question" },
        sessionID: "ses_fixture",
        title: "Choose a direction",
      },
    },
  });
  await transcript.event({
    type: "form.cancelled",
    created: 2800,
    data: { id: "frm_fixture", sessionID: "ses_fixture" },
  });
  await transcript.stop();
  const f = await inboxBrowserFixture(root, [], {
    [sessionID]: messages as Message[],
  });
  f.add({
    ...f.entries[0],
    id: "opcv2-ses_child",
    parentID: sessionID,
    title: "Inspect fixture",
  });
  const client = new WsClient(f.url);
  await client.connect(f.entries[0].directory);
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
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
      ) throw new Error("Foreign notices lease");
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
          throw new Error("Command outside notices scenario");
      }
    },
  };
}
