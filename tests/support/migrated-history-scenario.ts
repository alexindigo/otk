// SPDX-License-Identifier: LGPL-3.0-only
import {
  mapMessage,
  type NativeMessage,
  scalarMessage,
} from "@otk/harness-opencode-v2-server";
import { fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
import { TurnTimingAccumulator } from "@otk/harness";
import { knownDerived, usageHeader, UsageLedger } from "@otk/protocol";

export async function migratedHistoryScenario() {
  const fixtureData = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/harness-opencode-v2-server/tests/migrated-history-fixture.json",
        import.meta.url,
      ),
    ),
  );
  const root = await fixture(), sessionID = "tstv1-otk";
  const messages = (fixtureData.v2 as unknown as NativeMessage[]).flatMap(
    (m, order) => {
      const value = mapMessage(m, sessionID, { order, replyTo: "prompt" });
      return value?.role === "assistant" ? [value] : [];
    },
  );
  const timing = new TurnTimingAccumulator();
  for (const message of messages) {
    if (message.role === "assistant") {
      timing.add({
        start: message.time.created,
        terminal: true,
        source: fixtureData.provenance.route,
        busy: [],
        waits: [],
        unknown: "migration",
        explanation:
          "The real end time was lost when opencode migrated this session.",
      });
    }
  }
  const ledger = new UsageLedger(
    sessionID,
    messages.flatMap((m) => m.role === "assistant" ? [usageHeader(m)] : []),
  );
  const known = new TurnTimingAccumulator();
  const start = fixtureData.nextPrompt + 1000, later = start + 10 * 86400000;
  const interruptedSource = (fixtureData.v2 as NativeMessage[]).find((m) =>
    m.type === "assistant" && m.error
  );
  if (!interruptedSource || interruptedSource.type !== "assistant") {
    throw new Error("Missing interrupted timing fixture");
  }
  const interruptedRaw: Extract<NativeMessage, { type: "assistant" }> = {
    ...interruptedSource,
    id: "missing-end-call",
    time: { created: start - 1000 },
    content: [{
      type: "text",
      text: "Interrupted without a recorded completion time.",
    }],
  };
  const interrupted = mapMessage(interruptedRaw, sessionID, {
    order: 90,
    replyTo: "missing-end-turn",
  });
  if (!interrupted || interrupted.role !== "assistant") {
    throw new Error("Missing mapped interruption");
  }
  messages.push(interrupted);
  const interruptedTiming = new TurnTimingAccumulator();
  interruptedTiming.add(
    scalarMessage(interruptedRaw, 90, "missing-end-turn").timing!,
  );
  const interruptedLedger = new UsageLedger(sessionID, [
    usageHeader(interrupted),
  ]);
  for (const [index, began] of [start, later].entries()) {
    known.add({
      start: began,
      end: began + 500,
      terminal: true,
      source: "scripted-busy-interval",
      busy: [{ start: began, end: began + 500 }],
      waits: [],
    });
    messages.push({
      id: `known-call-${index}`,
      sessionID,
      sourceOrder: 100 + index,
      role: "assistant",
      replyTo: "known-turn",
      agent: "junior",
      model: { provider: "fake", model: "scripted" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      time: { created: began, completed: began + 500 },
      parts: [{
        id: `known-part-${index}`,
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: index
              ? "Only the two recorded half-second calls count as work."
              : "The calls below resumed ten days apart.",
          }],
        }],
      }],
    });
  }
  const knownLedger = new UsageLedger(
    sessionID,
    messages.flatMap((m) =>
      m.role === "assistant" && m.replyTo === "known-turn"
        ? [usageHeader(m)]
        : []
    ),
  );
  const f = await inboxBrowserFixture(
    root,
    [],
    { [sessionID]: messages },
    undefined,
    (_store, entries) => {
      entries[0].digest = {
        state: "ready",
        revision: 1,
        turns: {
          prompt: knownDerived(
            { ...ledger.summary("prompt")!, timing: timing.result() },
            "native-migration-fixture",
            1,
            true,
          ),
          "known-turn": knownDerived(
            { ...knownLedger.summary("known-turn")!, timing: known.result() },
            "scripted-busy-intervals",
            1,
            true,
          ),
          "missing-end-turn": knownDerived(
            {
              ...interruptedLedger.summary("missing-end-turn")!,
              timing: interruptedTiming.result(),
            },
            "native-aborted-fixture",
            1,
            true,
          ),
        },
      };
    },
  );
  // Metadata bootstrap does not publish digest authority. This external harness
  // supplies its results through the same index port as the other usage fixtures.
  f.app.index.applyDigest({
    id: sessionID,
    revision: 1,
    summary: { state: "ready", revision: 1 },
    turns: { upsert: f.entries[0].digest.turns, remove: [] },
    deleted: null,
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
      ) throw new Error("Foreign migrated-history lease");
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
          throw new Error("Command outside migrated-history scenario");
      }
    },
  };
}
