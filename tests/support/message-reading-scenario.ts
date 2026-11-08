// SPDX-License-Identifier: LGPL-3.0-only
import {
  type AssistantMessage,
  type Message,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { registerUsage } from "../../core/mod.ts";
import { fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
export async function messageReadingScenario() {
  const root = await fixture(), sessionID = "tstv1-otk";
  const part = (id: string, text: string) => ({
    id,
    kind: "text" as const,
    synthetic: false,
    blocks: [{
      b: "paragraph" as const,
      inline: [{ i: "text" as const, text }],
    }],
  });
  const reply = (id: string): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "reported-model" },
    time: { created: 2000, completed: 6000, lastOutput: 5500 },
    tokens: {
      input: 10,
      output: 20,
      reasoning: 5,
      cache: { read: 2, write: 1 },
    },
    cost: .125,
    interrupted: false,
    parts: [],
  });
  const base = {
    callID: "call",
    status: "completed" as const,
    time: { start: 2000, end: 6000 },
  };
  const messages: Message[] = [{
    id: "user",
    sessionID,
    role: "user",
    agent: "build",
    model: { provider: "test", model: "reported-model" },
    time: { created: 1000 },
    parts: [part("user-text", "Read this project")],
  }, {
    ...reply("step-1"),
    parts: [
      part(
        "prose",
        "A readable reply stays in a centred lane with source and diffs aligned to its shared edges. "
          .repeat(12),
      ),
      {
        id: "source",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "code",
          lang: "ts",
          text: "const readingColumn = true;",
        }],
      },
      {
        id: "thought",
        kind: "reasoning",
        time: { start: 2000, end: 6000 },
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Reasoning remains available." }],
        }],
      },
      {
        id: "bash",
        kind: "tool",
        call: {
          ...base,
          tool: "bash",
          command: "pwd",
          description: "Project directory",
          output: "reported directory",
        },
      },
      {
        id: "edit",
        kind: "tool",
        call: {
          ...base,
          callID: "edit",
          tool: "edit",
          path: root + "/projects/otk/source.ts",
          diagnostics: [],
          files: [{
            path: root + "/projects/otk/source.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            hunks: [{
              oldStart: 1,
              newStart: 1,
              oldLines: 1,
              newLines: 1,
              lines: [{ kind: "del", text: "const before = true;", oldNo: 1 }, {
                kind: "add",
                text: "const after = true;",
                newNo: 1,
              }],
            }],
          }],
        },
      },
      { id: "step-boundary", kind: "step", phase: "finish" },
      { id: "bookkeeping", kind: "meta" },
      { id: "step-next", kind: "step", phase: "start" },
      {
        id: "continued-read",
        kind: "tool",
        call: {
          ...base,
          callID: "continued",
          tool: "read",
          output: "Unrecognized read result\n<literal>keep me</literal>",
          path: root + "/projects/otk/source.ts",
          loaded: [],
        },
      },
      {
        id: "rename",
        kind: "tool",
        call: {
          ...base,
          callID: "rename",
          tool: "patch",
          files: [{
            path: root + "/projects/otk/new-name.ts",
            oldPath: "old-name.ts",
            status: "moved",
            additions: 0,
            deletions: 0,
            hunks: [],
          }],
        },
      },
    ],
  }, {
    ...reply("step-2"),
    interrupted: true,
    time: { created: 6000, completed: 8000, lastOutput: 7500 },
    parts: [part("done", "The reply is complete.")],
  }];
  const f = await inboxBrowserFixture(root, [], { [sessionID]: messages });
  const usage = new UsageLedger(
    sessionID,
    messages.filter((m): m is AssistantMessage => m.role === "assistant").map(
      usageHeader,
    ),
  ).snapshot();
  Object.assign(f.app.backend.capabilities, {
    usage: {
      getUsage: (_id: string, turnID: string) =>
        Promise.resolve(turnDetail(usage, turnID)),
    },
  });
  registerUsage(f.app.connections.rpc, f.app.backend);
  publishUsage(f.app.index, usage);
  const client = new WsClient(f.url);
  await client.connect(f.entries[0].directory);
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
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
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign reading lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Reading already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { frames: client.frames };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action === "fail") {
            f.update(sessionID, {
              status: "retry",
              retry: {
                attempt: 2,
                message: "Provider is temporarily unavailable",
                next: Date.now() + 6000,
              },
            });
          } else if (frame.params.action === "succeed") {
            f.update(sessionID, {
              status: "idle",
              retry: undefined,
            });
          } else throw new Error("Reading action outside scenario");
          return null;
        case "stop":
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside reading scenario");
      }
    },
  };
}
