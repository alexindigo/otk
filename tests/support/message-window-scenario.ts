// SPDX-License-Identifier: LGPL-3.0-only
import type { Message } from "@otk/protocol";
import { mapPart } from "@otk/harness-opencode-v1";
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
  const geometry: Record<string, Message[]> = {};
  for (
    const [name, text] of [
      [
        "atmosphera",
        "Please review this image alongside the complete prompt. ".repeat(10),
      ],
      ["globnotes", ""],
      ["luch", "A short prompt"],
    ]
  ) {
    const id = `tstv1-${name}`;
    geometry[id] = [{
      id: "geometry-prompt",
      sessionID: id,
      role: "user",
      time: { created: 1795291200000 },
      parts: [
        ...(text
          ? [{
            id: "geometry-text",
            kind: "text" as const,
            synthetic: false,
            blocks: [{
              b: "paragraph" as const,
              inline: [{ i: "text" as const, text }],
            }],
          }]
          : []),
        ...(name !== "luch"
          ? [{
            id: "geometry-image",
            kind: "file" as const,
            name: "geometry.svg",
            path: "geometry.svg",
            mime: "image/svg+xml",
            url: "data:image/svg+xml," +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="230" height="198"><rect width="230" height="198" fill="#234651"/><circle cx="115" cy="99" r="65" fill="#e8ae65"/></svg>',
              ),
          }]
          : []),
      ],
    }, {
      id: "geometry-reply",
      sessionID: id,
      role: "assistant",
      replyTo: "geometry-prompt",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1795291201000, completed: 1795291202000 },
      outcomeTime: { state: "known", at: 1795291202000, source: "completed" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [{
        id: "geometry-answer",
        kind: "text",
        synthetic: false,
        blocks: Array.from(
          { length: 24 },
          (_, i) => ({
            b: "paragraph",
            inline: [{
              i: "text",
              text:
                `Review line ${i}: the image and prompt retain their inline position while reading.`,
            }],
          }),
        ),
      }],
    }];
  }
  geometry["tstv1-other-finished"] = geometry["tstv1-luch"].map((message) => ({
    ...message,
    sessionID: "tstv1-other-finished",
    parts: message.role === "assistant"
      ? [{
        id: "short-answer",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text:
              "The image is clear. Both messages keep their time and actions visible.",
          }],
        }],
      }]
      : message.parts,
  }));
  geometry["tstv1-inline-tail"] = [
    geometry["tstv1-atmosphera"][0],
    geometry["tstv1-other-finished"][1],
  ].map((message) => ({ ...message, sessionID: "tstv1-inline-tail" }));
  const f = await inboxBrowserFixture(root, [], {
    [sessionID]: messages,
    ...geometry,
  });
  f.add({
    ...f.entries[0],
    id: "tstv1-inline-tail",
    title: "Inline footprint",
  });
  const client = new WsClient(f.url);
  await client.connect(f.entries[0].directory);
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
          if (disclosure && frame.params.action === "thaw") {
            for (
              const [n, type] of ["step-start", "step-finish", "snapshot"]
                .entries()
            ) {
              messages.push({
                id: `context-${n}`,
                sessionID,
                role: "context",
                time: { created: n + 3 },
                parts: [
                  mapPart({
                    id: `context-part-${n}`,
                    type,
                    messageID: `context-${n}`,
                    sessionID,
                    snapshot: "sha",
                  }),
                ],
              });
            }
            return null;
          }
          if (disclosure && frame.params.action === "hold") {
            const native = (type: string, n: number) =>
              mapPart({
                id: `bookkeeping-${n}`,
                type,
                messageID: "reply",
                sessionID,
                snapshot: "native-snapshot-sha",
                reason: "stop",
              });
            const tool = messages[0].parts[0];
            messages[0].parts = [
              native("step-start", 1),
              tool,
              native("step-finish", 2),
              native("snapshot", 3),
              native("step-start", 4),
              { ...tool, id: "write-2" },
              native("step-finish", 5),
            ];
            return null;
          }
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
