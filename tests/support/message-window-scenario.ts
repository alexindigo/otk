// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "@otk/protocol";
import { fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** Original external-backend scenes; only their browser driver changes. */
export async function messageWindowScenario(profile: Profile) {
  const root = await fixture(), sessionID = "tstv1-otk";
  const anchor = profile === "contract-messages-anchor";
  const diff = profile === "contract-messages-diff";
  const disclosure = profile === "contract-messages-disclosures";
  const lines = Array.from(
    { length: 1000 },
    (_, i) => `source_line_${String(i).padStart(4, "0")} = ${i};`,
  );
  const messages: Message[] = diff || disclosure
    ? [{
      id: "reply",
      sessionID,
      role: "assistant",
      replyTo: "prompt",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1, completed: 2 },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [{
        id: diff ? "edit" : "write",
        kind: "tool",
        call: diff
          ? {
            tool: "edit",
            callID: "edit",
            status: "completed",
            awaitingPermission: false,
            time: { start: 1, end: 2 },
            path: root + "/window.ts",
            diagnostics: [],
            files: [{
              path: root + "/window.ts",
              status: "modified",
              additions: 1000,
              deletions: 0,
              hunks: [{
                oldStart: 1,
                newStart: 1,
                oldLines: 0,
                newLines: 1000,
                lines: lines.map((text, i) => ({
                  kind: "add",
                  text,
                  newNo: i + 1,
                })),
              }],
            }],
          }
          : {
            tool: "write",
            callID: "write",
            status: "completed",
            awaitingPermission: false,
            time: { start: 1, end: 2 },
            path: root + "/project.ts",
            content: "const foldedSecret = 42;",
            diagnostics: [],
          },
      }],
    }]
    : Array.from({ length: 105 }, (_, i) => ({
      id: `${anchor ? "anchor" : "prompt"}-${i}`,
      sessionID,
      role: "user",
      time: { created: i + 1 },
      parts: [{
        id: `text-${i}`,
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: `${anchor ? "Anchored" : "Window"} prompt ${i}`,
          }],
        }],
      }],
    }));
  const f = await inboxBrowserFixture(root, [], { [sessionID]: messages });
  const client = new WsClient(f.url);
  await client.connect();
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await client.rpc("prefs.set", { key: "animationsOff", value: true });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  const gate = Promise.withResolvers<void>();
  let holding = anchor, pending = 0;
  const read = f.app.backend.core.listMessages.bind(f.app.backend.core);
  f.app.backend.core.listMessages = async (id, options, signal) => {
    if (holding && options.before) {
      pending++;
      await gate.promise;
    }
    return await read(id, options, signal);
  };
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
      ) throw new Error("Foreign window lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Window already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { pending, frames: client.frames };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action !== "release") {
            throw new Error(
              "Window action outside scenario",
            );
          }
          holding = false;
          gate.resolve();
          return null;
        case "stop":
          holding = false;
          gate.resolve();
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside window scenario");
      }
    },
  };
}
