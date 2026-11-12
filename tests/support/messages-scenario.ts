// SPDX-License-Identifier: LGPL-3.0-only
import { fixture } from "./config.ts";
import { messageWindowScenario } from "./message-window-scenario.ts";
import { messageUsageScenario } from "./message-usage-scenario.ts";
import { messageCostScenario } from "./message-cost-scenario.ts";
import { messageReadingScenario } from "./message-reading-scenario.ts";
import { migratedHistoryScenario } from "./migrated-history-scenario.ts";
import { publicUiScenario } from "./public-ui-scenario.ts";
import { recordedMessageScenario } from "./recorded-message-scenario.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import { mapDiffs, mapTool, type RawPart } from "@otk/harness-opencode-v1";
import {
  type AssistantMessage,
  type FileDiff,
  type Message,
  type ModelCatalog,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import type { Capabilities } from "@otk/harness";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** External-backend message contracts retain their original real core/UI owner. */
export async function messagesScenario(profile: Profile) {
  if (profile === "contract-messages-migrated-history") {
    return await migratedHistoryScenario();
  }
  if (profile.startsWith("contract-messages-recorded-")) {
    return await recordedMessageScenario(profile);
  }
  if (profile === "contract-messages-public-ui") {
    return await publicUiScenario();
  }
  if (profile === "contract-messages-reading") {
    return await messageReadingScenario();
  }
  if (profile === "contract-messages-session-cost") {
    return await messageCostScenario();
  }
  if (
    [
      "contract-messages-usage-paging",
      "contract-messages-usage-unknown",
      "contract-messages-usage-queued",
      "contract-messages-usage-priced",
      "contract-messages-usage-unreported",
    ].includes(profile)
  ) return await messageUsageScenario(profile);
  if (
    [
      "contract-messages-window",
      "contract-messages-anchor",
      "contract-messages-diff",
      "contract-messages-disclosures",
    ].includes(profile)
  ) {
    return await messageWindowScenario(profile);
  }
  const root = await fixture(), sessionID = "tstv1-core";
  const capabilities: Capabilities = {};
  const assistant = (id = "reply"): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: 2000, completed: 6000 },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [],
  });
  const highlight = (
    marker: string,
    source = "const stableValue: number = 7;",
  ): AssistantMessage => ({
    ...assistant(),
    parts: [{
      id: "text",
      kind: "text",
      synthetic: false,
      blocks: [
        { b: "code", lang: "ts", text: source },
        { b: "paragraph", inline: [{ i: "text", text: marker }] },
      ],
    }],
  });
  let messages: AssistantMessage[] = [];
  let ledger: UsageLedger | undefined;
  let prefix: Message[] = [], moneyIndex = 0;
  const amounts = [0, .00000005, .0096, .01, 1.2, 1234.567];
  const pricedCatalog: ModelCatalog = {
    defaultState: "unknown",
    providers: [{
      id: "test",
      name: "Test provider",
      models: [{
        id: "test",
        name: "Test model",
        variants: [],
        status: "active",
        free: false,
        cost: { input: 2, output: 4, cache: { read: .5, write: 3 } },
      }],
    }],
  };
  const moneyMessage = (): AssistantMessage => ({
    ...assistant("call"),
    time: { created: 2, completed: 1002 },
    tokens: {
      input: 100,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    cost: amounts[moneyIndex],
    parts: [{
      id: "text",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "One money rule." }],
      }],
    }],
  });
  const catalogReady = Promise.withResolvers<ModelCatalog>();
  const catalog: ModelCatalog = {
    defaultState: "configured",
    default: { provider: "opencode", model: "beam-free" },
    providers: [{
      id: "opencode",
      name: "OpenCode",
      models: [{
        id: "beam-free",
        name: "Beam Free",
        free: true,
        status: "active",
        variants: [],
        contextLimit: 10000,
      }],
    }],
  };
  const modelCalls: string[] = [];
  if (profile === "contract-messages-clock") {
    prefix = [{
      id: "user",
      sessionID,
      role: "user",
      time: { created: 1000 },
      parts: [{
        id: "prompt-text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Show timestamp behavior" }],
        }],
      }],
    }];
    messages = [{
      ...assistant(),
      time: { created: 2000, completed: 6000, lastOutput: 5500 },
      parts: [{
        id: "reply-text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: "first output then more and more final output",
          }],
        }],
      }],
    }];
    ledger = new UsageLedger(sessionID, messages.map(usageHeader));
    capabilities.usage = {
      getUsage: (_id, turnID) =>
        Promise.resolve(turnDetail(ledger!.snapshot(), turnID)),
    };
    capabilities.prompt = {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
  } else if (profile === "contract-messages-highlight") {
    messages = [highlight("Baseline")];
  } else if (profile === "contract-messages-context") {
    capabilities.models = {
      listModels: (id) => {
        modelCalls.push(id);
        return modelCalls.length === 1
          ? catalogReady.promise
          : Promise.resolve(catalog);
      },
    };
    messages = [{
      ...assistant("usage"),
      model: catalog.default!,
      time: { created: 1, completed: 2 },
      tokens: {
        input: 2400,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }];
    ledger = new UsageLedger(sessionID, messages.map(usageHeader));
  } else if (profile === "contract-messages-money") {
    messages = [moneyMessage()];
    ledger = new UsageLedger(sessionID, messages.map(usageHeader));
    capabilities.usage = {
      getUsage: (_id, turnID) =>
        Promise.resolve(turnDetail(ledger!.snapshot(), turnID)),
    };
    capabilities.models = { listModels: () => Promise.resolve(pricedCatalog) };
  } else if (profile.startsWith("contract-messages-labels")) {
    messages = [{
      ...assistant(),
      time: { created: 1000, completed: 2000 },
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }];
    ledger = new UsageLedger(sessionID, messages.map(usageHeader));
    capabilities.usage = {
      getUsage: (_id, turnID) =>
        Promise.resolve(turnDetail(ledger!.snapshot(), turnID)),
    };
    capabilities.prompt = {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
    if (profile.endsWith("-picker")) {
      capabilities.agents = { listAgents: () => Promise.resolve([]) };
    }
  } else if (profile === "contract-messages-collapse") {
    const file = (path: string): FileDiff => ({
      path,
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
    });
    const base = {
      callID: "call",
      status: "completed" as const,
      time: { start: 2000, end: 6000 },
    };
    messages = [{
      ...assistant(),
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      parts: [
        {
          id: "edit",
          kind: "tool",
          call: {
            ...base,
            tool: "edit",
            path: root + "/edit.ts",
            files: [file(root + "/edit.ts")],
            diagnostics: [],
          },
        },
        {
          id: "write",
          kind: "tool",
          call: {
            ...base,
            callID: "write",
            tool: "write",
            path: root + "/write.ts",
            content: "const written = true;",
            lang: "ts",
            diagnostics: [],
          },
        },
        {
          id: "patch",
          kind: "tool",
          call: {
            ...base,
            callID: "patch",
            tool: "patch",
            files: [file(root + "/patch.ts")],
          },
        },
        {
          id: "read",
          kind: "tool",
          call: {
            ...base,
            callID: "read",
            tool: "read",
            path: root + "/read.ts",
            loaded: [],
            output: "Read result",
          },
        },
      ],
    }];
    prefix = [{
      id: "user",
      sessionID,
      role: "user",
      time: { created: 1000 },
      parts: [{
        id: "text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Review the file changes" }],
        }],
      }],
    }];
    ledger = new UsageLedger(sessionID, messages.map(usageHeader));
    capabilities.usage = {
      getUsage: (_id, turnID) =>
        Promise.resolve(turnDetail(ledger!.snapshot(), turnID)),
    };
    capabilities.prompt = {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
  } else if (profile === "contract-messages-facts") {
    capabilities.agents = {
      listAgents: () =>
        Promise.resolve([
          { name: "action", color: "accent" },
          { name: "alternate", color: "secondary" },
          { name: "literal", color: "#12abEF" },
          { name: "uncoloured" },
        ]),
    };
    capabilities.prompt = {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
    messages = [{
      ...assistant(),
      agent: "action",
      agentColor: "accent",
      parts: [
        {
          id: "task",
          kind: "tool",
          call: {
            tool: "task",
            callID: "task",
            status: "completed",
            time: { start: 2000, end: 3000 },
            description: "Inspect the result",
            progress: { state: "unavailable", revision: 0, toolCount: null },
            childSessionID: "tstv1-child",
          },
        },
        {
          id: "external",
          kind: "tool",
          call: {
            tool: "external",
            name: "external-preview",
            callID: "external",
            status: "completed",
            time: { start: 3000, end: 6000 },
            summary: "A backend-owned preview",
            output: "A short preview from another backend.",
            outputTruncated: true,
          },
        },
      ],
    }];
  } else if (profile === "contract-messages-metadata") {
    const raw = (
      id: string,
      tool: string,
      output?: string,
      metadata: Record<string, unknown> = {},
    ): RawPart => ({
      id,
      sessionID: "native",
      messageID: "reply",
      type: "tool",
      callID: id,
      tool,
      state: {
        status: "completed",
        input: {},
        output,
        metadata,
        time: { start: 1000, end: 2000 },
      },
    });
    capabilities.prompt = {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
    messages = [{
      ...assistant(),
      agent: "reviewer",
      model: { provider: "unreported", model: "model" },
      tokens: {
        input: null,
        output: 0,
        reasoning: null,
        cache: { read: null, write: 0 },
      },
      cost: null,
      parts: [
        {
          kind: "tool",
          id: "unknown-search",
          call: mapTool(raw("unknown-search", "grep")),
        },
        {
          kind: "tool",
          id: "zero-search",
          call: mapTool(raw("zero-search", "grep", undefined, { matches: 0 })),
        },
        {
          kind: "tool",
          id: "unknown-diff",
          call: {
            tool: "patch",
            callID: "unknown-diff",
            status: "completed",
            time: {},
            files: mapDiffs([{ additions: 0, deletions: 0 }]),
          },
        },
        {
          kind: "tool",
          id: "plain-output",
          call: mapTool(
            raw(
              "plain-output",
              "external",
              Array.from({ length: 15 }, (_, i) => `Output line ${i + 1}`).join(
                "\n",
              ),
            ),
          ),
        },
      ],
    }];
  } else if (/^contract-messages-usage(?:3|120|500)$/.test(profile)) {
    const count = Number(profile.slice("contract-messages-usage".length));
    messages = Array.from({ length: count }, (_, i) => ({
      ...assistant(`call-${String(i + 1).padStart(3, "0")}`),
      time: { created: i * 1000 + 2, completed: i * 1000 + 902 },
      tokens: {
        input: (i + 1) * 800,
        output: 80,
        reasoning: 20,
        cache: { read: (i + 1) * 150, write: (i + 1) * 50 },
      },
      cost: .01,
      parts: i === count - 1
        ? [{
          kind: "text",
          id: "answer",
          synthetic: false,
          blocks: [{
            b: "paragraph",
            inline: [{ i: "text", text: "Run complete." }],
          }],
        }]
        : [],
    }));
    ledger = new UsageLedger(
      sessionID,
      messages.map((message, i) => ({
        ...usageHeader(message),
        tools: i < count - 1
          ? [{
            id: `tool-${i}`,
            name: "read",
            summary:
              "packages/client/session-usage.ts and every dependent consumer of the complete turn metadata",
          }]
          : [],
      })),
    );
    capabilities.usage = {
      getUsage: (_id, turnID) =>
        Promise.resolve(turnDetail(ledger!.snapshot(), turnID)),
    };
    capabilities.models = {
      listModels: () =>
        Promise.resolve({
          defaultState: "unknown",
          providers: [{
            id: "test",
            name: "Test provider",
            models: [{
              id: "test",
              name: "Test model",
              variants: [],
              status: "active",
              free: false,
              cost: { input: 2, output: 4, cache: { read: .5, write: 3 } },
            }],
          }],
        }),
    };
  } else throw new Error("Unknown message contract profile");
  const f = await coreBackendFixture(root, capabilities);
  f.app.backend.core.listMessages = (_id, options) =>
    Promise.resolve(f.page([...prefix, ...messages], options.before));
  if (ledger) publishUsage(f.app.index, ledger.snapshot());
  const client = new WsClient(f.url);
  await client.connect(root);
  resources().defer("message contract client", () => client.close());
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await client.rpc("prefs.set", { key: "animationsOff", value: true });
  if (
    profile === "contract-messages-facts" ||
    profile === "contract-messages-metadata"
  ) await client.rpc("prefs.set", { key: "genericToolOutput", value: true });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined, replacement = 0;
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
      const p = frame.params;
      if (
        "lease" in p && p.lease !== undefined && p.lease !== lease?.lease
      ) throw new Error("Foreign message contract lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Message contract already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            frames: client.frames,
            requests: [],
            replacement,
            modelCalls,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (
            profile === "contract-messages-context" &&
            frame.params.action === "release"
          ) {
            catalogReady.resolve(catalog);
            return null;
          }
          if (
            profile === "contract-messages-money" &&
            frame.params.action === "release"
          ) {
            if (++moneyIndex >= amounts.length) {
              throw new Error(
                "Money samples exhausted",
              );
            }
            messages = [moneyMessage()];
            ledger = new UsageLedger(sessionID, messages.map(usageHeader));
            publishUsage(f.app.index, ledger.snapshot());
            return null;
          }
          if (
            profile === "contract-messages-labels" &&
            frame.params.action === "release"
          ) {
            f.app.connections.content(sessionID, {
              op: "session.revert",
              messageID: "user",
              messageCount: 1,
              files: [{ path: "example.ts", additions: 1, deletions: 1 }],
            });
            return null;
          }
          if (profile !== "contract-messages-highlight") {
            throw new Error(
              "No message mutation for this profile",
            );
          }
          if (frame.params.action === "release") {
            messages = [
              highlight(`Replacement ${replacement++}`),
            ];
          } else if (frame.params.action === "succeed") {
            messages = [
              highlight("Changed source", "const changedValue: number = 8;"),
            ];
          } else throw new Error("Unknown message contract mutation");
          f.app.connections.content(sessionID, {
            op: "message.upsert",
            message: messages[0],
          });
          return null;
        case "stop":
          catalogReady.resolve(catalog);
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside message contract");
      }
    },
  };
}
