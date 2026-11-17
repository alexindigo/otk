// SPDX-License-Identifier: LGPL-3.0-only
import {
  type AssistantMessage,
  type Message,
  OperationFailure,
  type PublicFailure,
  UsageLedger,
} from "@otk/protocol";
import type { Capabilities } from "@otk/harness";
import { coreBackendFixture } from "./core-backend.ts";
import { fixture } from "./config.ts";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import { WsClient } from "./ws-client.ts";
import { resources } from "./resources.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

/** Real core/client/command paging with an external backend's retained failure. */
export async function failureOwnershipScenario() {
  const root = await fixture(),
    sessionID = "tstv1-core",
    pages: (string | null)[] = [];
  let mode: "mixed" | "reveal" | "missing" = "mixed";
  const failure: PublicFailure = {
    code: "fixture.retained",
    retry: "none",
    diagnosticID: "retained-fixture",
    facts: {
      actionLabel: "Sending prompt",
      reason: "Retained native failure",
      outcome: "rejected",
      target: { sessionID, label: "Failure ownership" },
      record: { messageID: "failure-old", label: "See the retained failure" },
    },
  };
  const record = (id: string, created: number, replyTo?: string): Message => ({
    id,
    sessionID,
    role: "context",
    time: { created },
    ...(replyTo ? { replyTo } : {}),
    parts: [{
      id: id + "-part",
      kind: "external",
      name: "fixture/request-failure",
      failure,
    }],
  });
  const prose = (id: string, created: number, text: string): Message => ({
    id,
    sessionID,
    role: "context",
    time: { created },
    parts: [{
      id: id + "-part",
      kind: "text",
      synthetic: false,
      blocks: [{ b: "paragraph", inline: [{ i: "text", text }] }],
    }],
  });
  const call: AssistantMessage = {
    id: "assistant",
    sessionID,
    role: "assistant",
    replyTo: "prompt",
    agent: "build",
    model: { provider: "fixture", model: "model" },
    time: { created: 20, completed: 30 },
    tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
    cost: 0.01,
    interrupted: false,
    parts: [{
      id: "answer",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{
          i: "text",
          text: "Assistant answer survives the context failure.",
        }],
      }],
    }],
  };
  const prompt: Message = {
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
        inline: [{ i: "text", text: "Keep the reply metadata and actions" }],
      }],
    }],
  };
  const capabilities: Capabilities = {
    prompt: {
      prompt: () =>
        Promise.reject(
          new OperationFailure(
            "rejected",
            failure.code,
            new Error("Fixture rejection"),
            failure.facts,
            failure.diagnosticID,
          ),
        ),
      abort: () => Promise.resolve(),
    },
    sessionActions: {
      rename: () => Promise.resolve(f.session),
      remove: () => Promise.resolve(),
      fork: () => Promise.resolve(f.session),
      compact: () => Promise.resolve(),
    },
    usage: {
      getUsage: () => Promise.resolve(turnDetail(usage, "prompt", f.clock())),
    },
  };
  const f = await coreBackendFixture(root, capabilities, sessionID);
  const usage = new UsageLedger(sessionID, [{
    id: "assistant",
    turnID: "prompt",
    completed: true,
    model: call.model,
    tokens: call.tokens,
    cost: call.cost,
    time: { start: 20, end: 30 },
  }]).snapshot();
  publishUsage(f.app.index, usage);
  f.app.backend.core.listMessages = (_id, options) => {
    pages.push(options.before ?? null);
    const messages = mode === "mixed"
      ? [prompt, call, record("failure-tail", 40, "prompt")]
      : [
        ...(mode === "reveal" ? [record("failure-old", 2)] : []),
        ...Array.from({ length: 50 }, (_, i) =>
          prose(
            "history-" + i,
            100 + i,
            "Retained context row " + i + ". " +
              "Visible history stays independent. ".repeat(4),
          )),
      ];
    return Promise.resolve(f.page(messages, options.before));
  };
  const client = new WsClient(f.url);
  await client.connect(root);
  resources().defer("failure ownership client", () => client.close());
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
  const registration = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (registration) {
    await Deno.writeTextFile(registration, JSON.stringify(info));
  }
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) {
        throw new Error("Foreign failure ownership lease");
      }
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { pages, mode, sessionID };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          mode = frame.params.action === "hold"
            ? "reveal"
            : frame.params.action === "fail"
            ? "missing"
            : "mixed";
          pages.length = 0;
          return null;
        case "stop":
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside failure ownership fixture");
      }
    },
  };
}
