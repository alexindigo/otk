// SPDX-License-Identifier: LGPL-3.0-only
import { mapTool, type RawPart } from "@otk/harness-opencode-v1";
import { type AssistantMessage, type Message } from "@otk/protocol";
import { fixture } from "./config.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";
/** T2 V scenes use characterized stock envelopes, with no provider journey replay. */
export async function recordedMessageScenario(profile: Profile) {
  const root = await fixture(),
    sessionID = "tstv1-core",
    family = profile.slice("contract-messages-recorded-".length),
    file = family === "files" ? "m3-file-tools" : "m3-basic-tools";
  const source = await Deno.readTextFile(
    new URL(`../fixtures/opencode1/${file}.json`, import.meta.url),
  );
  const raw = JSON.parse(
    source.replace(
      /\/home\/tester\/otk\/\.test-state\/oc-[^/]+\/project/g,
      root,
    ),
  ) as RawPart[];
  if (family === "tools") {
    const generic = raw.find((part) => part.tool === "echo_fixture")!;
    generic.state!.output = Array.from(
      { length: 15 },
      (_, i) => `Generic line ${i + 1}`,
    ).join("\n");
  }
  if (family === "files") {
    // Retain the original wrap-stressing edit, not just a short happy-path diff.
    const edit = raw.find((p) => p.tool === "edit")!;
    Object.assign(
      edit,
      JSON.parse(
        JSON.stringify(edit).replaceAll(
          "newValue",
          "newValue_" + "x".repeat(200),
        ),
      ),
    );
  }
  const messages: Message[] = [
    {
      id: "prompt",
      sessionID,
      role: "user",
      time: { created: 1 },
      parts: [{
        id: "prompt-text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Review the recorded tool states" }],
        }],
      }],
    },
    ...raw.map((part, i): AssistantMessage => ({
      id: `reply-${i}`,
      sessionID,
      role: "assistant",
      replyTo: `prompt-${i}`,
      agent: "build",
      model: { provider: "fake", model: "scripted" },
      time: { created: 2 + i * 1000, completed: 1002 + i * 1000 },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [{ id: part.id, kind: "tool", call: mapTool(part) }],
    })),
  ];
  const f = await coreBackendFixture(root);
  f.app.backend.core.listMessages = (_id, options) =>
    Promise.resolve(f.page(messages, options.before));
  const client = new WsClient(f.url);
  await client.connect(root);
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await client.rpc("prefs.set", { key: "genericToolOutput", value: true });
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
      ) throw new Error("Foreign recorded scene lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Recorded scene already leased");
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
          throw new Error("Command outside recorded scene");
      }
    },
  };
}
