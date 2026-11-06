// SPDX-License-Identifier: LGPL-3.0-only
import {
  type AssistantMessage,
  type Message,
  type ModelCatalog,
  type SessionUsage,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "./config.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

export async function messageUsageScenario(profile: Profile) {
  const root = await fixture(), sessionID = "tstv1-core";
  const paging = profile.endsWith("-paging"),
    queued = profile.endsWith("-queued"),
    priced = profile.endsWith("-priced"),
    unreported = profile.endsWith("-unreported");
  const step = (
    id: string,
    provider = "test",
    input: number | null = 100000,
  ): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider, model: queued ? "shared" : "model" },
    time: { created: 1, completed: 2 },
    tokens: {
      input,
      output: 20000,
      reasoning: 30000,
      cache: { read: 40000, write: 50000 },
    },
    cost: .43,
    interrupted: false,
    parts: [],
  });
  const messages: Message[] = paging
    ? [
      { id: "user", sessionID, role: "user", time: { created: 1 }, parts: [] },
      ...Array.from({ length: 102 }, (_, i): AssistantMessage => ({
        ...step(`step-${String(i).padStart(3, "0")}`),
        time: { created: i * 1000 + 2, completed: i * 1000 + 1002 },
        tokens: {
          input: 1,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: .01,
        parts: [{
          id: `text-${i}`,
          kind: "text",
          synthetic: false,
          blocks: [{
            b: "paragraph",
            inline: [{ i: "text", text: `Charged backend step ${i}.` }],
          }],
        }],
      })),
    ]
    : priced
    ? [1, 2, 3].map((n) => ({
      ...step("priced-" + n, "priced"),
      model: { provider: "priced", model: "priced" },
      time: { created: n * 1000, completed: n * 1000 + 900 },
      tokens: {
        input: n * 80000,
        output: n * 8000,
        reasoning: n * 2000,
        cache: { read: n * 20000, write: 0 },
      },
      cost: n * .21,
      parts: n < 3
        ? [{
          id: "priced-tool-" + n,
          kind: "tool" as const,
          call: {
            tool: "bash" as const,
            callID: "priced-tool-" + n,
            status: "completed" as const,
            awaitingPermission: false,
            time: { start: n * 1000, end: n * 1000 + 800 },
            command: n === 1 ? "pwd" : "ls -la",
            output: n === 1 ? "/project" : "fixture.txt",
          },
        }]
        : [],
    }))
    : queued
    ? [step("first-step", "first"), {
      id: "queued",
      sessionID,
      role: "user",
      time: { created: 2 },
      parts: [],
    }, step("last-step", "second")]
    : unreported
    ? [{
      ...step("call", "test", null),
      cost: null,
      tokens: {
        input: null,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      parts: [{
        id: "text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: "Usage reported independently of loaded pages.",
          }],
        }],
      }],
    }]
    : [{
      ...step("usage", "unknown", 100),
      tokens: {
        input: 100,
        output: 20,
        reasoning: 30,
        cache: { read: 40, write: 50 },
      },
    }];
  const ledger = new UsageLedger(
    sessionID,
    messages.filter((m): m is AssistantMessage => m.role === "assistant").map(
      usageHeader,
    ),
  );
  const calls: unknown[] = [],
    pageGates = new Map<number, PromiseWithResolvers<void>>();
  let hold: PromiseWithResolvers<SessionUsage> | undefined,
    held = false,
    pendingPages = 0;
  const catalog: ModelCatalog = {
    defaultState: "unknown",
    providers: ["first", "second"].map((id, i) => ({
      id,
      name: id,
      models: [{
        id: "shared",
        name: "Shared model ID",
        variants: [],
        status: "active",
        free: false,
        cost: {
          input: (i + 1) * 2,
          output: (i + 1) * 4,
          cache: { read: (i + 1) * .5, write: (i + 1) * 3 },
        },
      }],
    })),
  };
  const f = await coreBackendFixture(root, {
    ...(queued || priced
      ? {
        models: {
          listModels: () =>
            Promise.resolve(
              priced
                ? {
                  defaultState: "unknown" as const,
                  providers: [{
                    id: "priced",
                    name: "Priced provider",
                    models: [{
                      ...catalog.providers[0].models[0],
                      id: "priced",
                    }],
                  }],
                }
                : catalog,
            ),
        },
      }
      : {}),
    usage: {
      getUsage: async (_id, turnID) => {
        const clock = f.clock();
        if (hold) {
          held = true;
          return turnDetail(await hold.promise, turnID, clock);
        }
        return turnDetail(ledger.snapshot(), turnID, clock);
      },
    },
  });
  f.app.backend.core.listMessages = async (_id, opts) => {
    calls.push(opts);
    const page = f.page(messages, opts.before);
    if (paging) {
      const gate = Promise.withResolvers<void>(), key = calls.length;
      pageGates.set(key, gate);
      pendingPages++;
      // Test-owned pending read is released explicitly by the Node observer.
      try {
        await gate.promise;
      } finally {
        pageGates.delete(key);
        pendingPages--;
      }
    }
    return page;
  };
  publishUsage(f.app.index, ledger.snapshot());
  const client = new WsClient(f.url);
  await client.connect(root);
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await client.rpc("prefs.set", { key: "animationsOff", value: true });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  const emit = (input: number, completed = false) => {
    const message: AssistantMessage = {
      ...step("live"),
      replyTo: "next-user",
      time: { created: 200000, ...(completed ? { completed: 201000 } : {}) },
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: input * .01,
      parts: [{
        id: "live-text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Live usage." }],
        }],
      }],
    };
    const at = messages.findIndex((m) => m.id === "live");
    if (at < 0) messages.push(message);
    else messages[at] = message;
    ledger.upsert(usageHeader(message));
    publishUsage(f.app.index, ledger.snapshot());
    f.app.connections.content(sessionID, { op: "message.upsert", message });
  };
  let lease: TestLease | undefined, phase = 0;
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
      ) throw new Error("Foreign usage lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Usage already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            calls,
            pendingPages,
            held,
            total: messages.length,
            frames: client.frames,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario": {
          const action = frame.params.action;
          if (action === "release") {
            for (const gate of pageGates.values()) gate.resolve();
            return null;
          }
          if (unreported && action === "succeed") {
            const next = {
              ...messages[0] as AssistantMessage,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              cost: 0,
            };
            messages[0] = next;
            ledger.upsert(usageHeader(next));
            f.app.connections.content(sessionID, {
              op: "message.upsert",
              message: next,
            });
            publishUsage(f.app.index, ledger.snapshot());
            return null;
          }
          if (!paging) throw new Error("No usage mutation");
          if (action === "hold") {
            hold = Promise.withResolvers<SessionUsage>();
            held = false;
            return null;
          }
          if (action !== "succeed") {
            throw new Error(
              "Usage action outside scenario",
            );
          }
          if (phase === 0) {
            emit(2);
            emit(2);
          } else if (phase === 1) emit(5);
          else if (phase === 2) {
            emit(7);
            emit(7);
            hold!.resolve(ledger.snapshot());
            hold = undefined;
          } else if (phase === 3) {
            emit(9, true);
            emit(9, true);
          } else throw new Error("Usage phases exhausted");
          phase++;
          return null;
        }
        case "stop":
          for (const gate of pageGates.values()) gate.resolve();
          hold?.resolve(ledger.snapshot());
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside usage scenario");
      }
    },
  };
}
