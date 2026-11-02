// SPDX-License-Identifier: LGPL-3.0-only
import {
  type AssistantMessage,
  type ContentSession,
  type Message,
  type SessionUsage,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "./config.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { fixturePage } from "./message-pages.ts";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
export async function messageCostScenario() {
  const root = await fixture();
  const step = (
    sessionID: string,
    id: string,
    cost: number,
    created = 2,
  ): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created, completed: created + 1 },
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost,
    interrupted: false,
    parts: [],
  });
  const messages: Message[] = [
    {
      id: "user",
      sessionID: "tstv1-core",
      role: "user",
      time: { created: 1 },
      parts: [],
    },
    ...Array.from(
      { length: 102 },
      (_, i) => step("tstv1-core", `step-${i}`, .01, i * 1000 + 2),
    ),
  ];
  messages.at(-1)!.parts = [{
    id: "text",
    kind: "text",
    synthetic: false,
    blocks: [{
      b: "paragraph",
      inline: [{
        i: "text",
        text: "Complete session usage, independent of transcript pages. "
          .repeat(100),
      }],
    }],
  }];
  const ledgers = new Map([
    [
      "tstv1-core",
      new UsageLedger(
        "tstv1-core",
        messages.filter((m): m is AssistantMessage => m.role === "assistant")
          .map(usageHeader),
      ),
    ],
    [
      "tstv1-helper",
      new UsageLedger("tstv1-helper", [
        usageHeader(step("tstv1-helper", "h", .07)),
      ]),
    ],
    ["tstv1-idle", new UsageLedger("tstv1-idle")],
    [
      "tstv1-other",
      new UsageLedger("tstv1-other", [
        usageHeader(step("tstv1-other", "o", 3.25)),
      ]),
    ],
  ]);
  const reads: string[] = [],
    contentReads: string[] = [],
    unknown = Promise.withResolvers<SessionUsage>();
  const f = await coreBackendFixture(root, {
    usage: {
      async getUsage(id, turnID) {
        reads.push(id);
        const ledger = ledgers.get(id);
        return turnDetail(
          ledger ? ledger.snapshot() : await unknown.promise,
          turnID,
        );
      },
    },
  });
  const base = f.app.index.get("tstv1-core")!;
  const entries = [{
    ...base,
    title: "Charged session with a deliberately long title to test truncation",
    directory: root + "/otk",
  }, {
    ...base,
    id: "tstv1-helper",
    parentID: "tstv1-core",
    title: "Explore callers",
    directory: root + "/otk",
    attention: { ...base.attention, questions: 1 },
  }, {
    ...base,
    id: "tstv1-idle",
    title: "Fresh session",
    directory: root + "/otk",
  }, {
    ...base,
    id: "tstv1-unknown",
    title: "Usage unavailable",
    directory: root + "/otk",
  }, {
    ...base,
    id: "tstv1-other",
    title: "Another project's session",
    directory: root + "/other-project",
  }];
  for (const entry of entries) f.app.index.upsert(entry);
  for (const ledger of ledgers.values()) {
    publishUsage(f.app.index, ledger.snapshot());
  }
  f.app.backend.core.getSession = (id) => {
    const entry = entries.find((e) => e.id === id)!;
    return Promise.resolve<ContentSession>({
      id,
      title: entry.title,
      directory: entry.directory,
      projectID: entry.projectID,
      parentID: entry.parentID,
      archived: false,
      time: { created: 1, updated: 1 },
    });
  };
  f.app.backend.core.listMessages = async (id, opts) => {
    contentReads.push(id);
    return fixturePage(
      id,
      id === "tstv1-core" ? messages : [],
      opts.before,
      await f.app.backend.core.getSession(id),
      f.clock(id),
    );
  };
  const client = new WsClient(f.url);
  await client.connect();
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await client.rpc("prefs.set", { key: "animationsOff", value: true });
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
      ) throw new Error("Foreign cost lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Cost already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            reads,
            contentReads,
            total: messages.length,
            title: entries[0].title,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action !== "succeed") {
            throw new Error(
              "Cost action outside scenario",
            );
          }
          {
            ledgers.get("tstv1-helper")!.upsert(
              usageHeader(step("tstv1-helper", "next", .05)),
            );
            const helper = f.app.index.get("tstv1-helper")!;
            f.app.index.upsert({
              ...helper,
              timeUpdated: helper.timeUpdated + 1,
            });
            publishUsage(f.app.index, ledgers.get("tstv1-helper")!.snapshot());
            const live = step("tstv1-core", "live", .03, 200000);
            messages.push(live);
            ledgers.get("tstv1-core")!.upsert(usageHeader(live));
            f.app.connections.content("tstv1-core", {
              op: "message.upsert",
              message: live,
            });
            publishUsage(f.app.index, ledgers.get("tstv1-core")!.snapshot());
            f.app.connections.content("tstv1-core", {
              op: "message.upsert",
              message: live,
            });
            return null;
          }
        case "stop":
          unknown.resolve(new UsageLedger("tstv1-unknown").snapshot());
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside cost scenario");
      }
    },
  };
}
