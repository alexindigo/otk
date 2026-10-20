// SPDX-License-Identifier: LGPL-3.0-only
import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { AssistantMessage, ModelCatalog } from "@otk/protocol";
import { replyMessages, replyMetadata } from "../replies.ts";
import { type Message, usageHeader, UsageLedger } from "@otk/protocol";
import { priceUsage, turnUsage, usageCost, usageTokens } from "../usage.ts";
const usageFor = (steps: AssistantMessage[], catalog?: ModelCatalog) =>
  priceUsage(
    new UsageLedger("s", steps.map(usageHeader)).snapshot().total,
    catalog,
  );
const replyUsage = (messages: Message[], catalog?: ModelCatalog) =>
  new Map(
    replyMessages(messages).flatMap((message) => {
      if (message.role !== "assistant") return [];
      const ledger = new UsageLedger(
        message.sessionID,
        messages.filter((m): m is AssistantMessage =>
          m.role === "assistant" && m.sessionID === message.sessionID
        ).map(usageHeader),
      );
      return [
        [
          message.id,
          priceUsage(
            ledger.snapshot().turns[message.replyTo ?? message.id],
            catalog,
          ),
        ] as const,
      ];
    }),
  );

const step = (
  id: string,
  provider = "one",
  replyTo = "user",
): AssistantMessage => ({
  id,
  sessionID: "s",
  role: "assistant",
  agent: "build",
  replyTo,
  model: { provider, model: "same-id" },
  time: { created: 1, completed: 2 },
  tokens: {
    input: 100000,
    output: 20000,
    reasoning: 30000,
    cache: { read: 40000, write: 50000 },
  },
  cost: .43,
  interrupted: false,
  parts: [],
});
const catalog: ModelCatalog = {
  providers: ["one", "two"].map((id, i) => ({
    id,
    name: id,
    models: [{
      id: "same-id",
      name: "Model",
      free: false,
      status: "active",
      variants: [],
      cost: {
        input: (i + 1) * 2,
        output: (i + 1) * 4,
        cache: { read: (i + 1) * .5, write: (i + 1) * 3 },
      },
    }],
  })),
};

Deno.test("charged turn usage accumulates every category across exact-model steps without counting step parts twice", () => {
  const first = step("a");
  first.parts = [{
    kind: "step",
    id: "bookkeeping",
    phase: "finish",
    tokens: first.tokens,
    cost: first.cost,
  }];
  const usage = replyUsage([
    first,
    step("b", "two"),
    step("c", "one", "next-user"),
  ], catalog);
  assertEquals([...usage.keys()], ["a", "c"]);
  const turn = usage.get("a")!;
  assertEquals(turn.tokens, 480000);
  assertEquals(turn.cost, .86);
  assertEquals(turn.categories.map((c) => c.tokens), [
    200000,
    40000,
    60000,
    80000,
    100000,
  ]);
  for (const [i, expected] of [.6, .24, .36, .06, .45].entries()) {
    assertAlmostEquals(turn.categories[i].cost!, expected);
  }
  assertEquals(usage.get("c")!.tokens, 240000);
});
Deno.test("usage retains reported cost and tokens when prices are unknown, and distinguishes known zero rates", () => {
  const known = step("a"), unknown = step("b", "missing");
  assertEquals(
    usageFor([known, unknown], catalog).categories.map((c) => c.cost),
    Array(5).fill(undefined),
  );
  const free = structuredClone(catalog);
  free.providers[0].models[0].cost = {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  };
  const usage = usageFor([known], free);
  assertEquals(usage.categories.map((c) => c.cost), [0, 0, 0, 0, 0]);
  assertEquals(
    usage.cost,
    .43,
    "Reported totals remain authoritative even when catalog pricing differs",
  );
  assertEquals(usageFor([unknown]).tokens, 240000);
});
Deno.test("full prompt context includes new input and both caches without double-counting charged tokens", () => {
  const first = step("first");
  const second = {
    ...step("second", "two"),
    tokens: {
      input: 80000,
      output: 40000,
      reasoning: 20000,
      cache: { read: 150000, write: 60000 },
    },
  };
  const ledger = new UsageLedger("s", [first, second].map(usageHeader));
  const turn = turnUsage(ledger.snapshot(), first, catalog)!;
  assertEquals(turn.calls.map((call) => call.context), [
    190000,
    290000,
  ]);
  assertEquals(turn.context, 480000);
  assertEquals(turn.tokens, 590000);
  assertEquals(turn.cost, .86);
  assertEquals(turn.categories.map((category) => category.label), [
    "New input",
    "Output",
    "Reasoning",
    "Cache read",
    "Cache write",
  ]);
  assertAlmostEquals(turn.categories[0].cost!, .52);
  assertAlmostEquals(turn.categories[3].cost!, .17);
  assertAlmostEquals(turn.categories[4].cost!, .51);
  assertEquals(usageFor([first, second]).context, 480000);
});
Deno.test("usage labels compact large counts while preserving small nonzero charges", () => {
  assertEquals(usageTokens(812000), "812K");
  assertEquals(usageTokens(0), "0");
  assertEquals(usageCost(.43), "$0.43");
  assertEquals(usageCost(0), "$0.00");
  assertEquals(usageCost(.000025), "$0.000025");
  assertEquals(usageCost(.00000005), "<$0.000001");
});

Deno.test("authoritative turn lookup rejects wrong-session, absent and inherited keys without page fallbacks", () => {
  const message = step("a");
  const snapshot = new UsageLedger("s", [usageHeader(message)]).snapshot();
  assertEquals(turnUsage(snapshot, message, catalog)?.tokens, 240000);
  assertEquals(turnUsage(undefined, message, catalog), undefined);
  assertEquals(
    turnUsage({ ...snapshot, sessionID: "other" }, message, catalog),
    undefined,
  );
  assertEquals(
    turnUsage(snapshot, { ...message, replyTo: "constructor" }, catalog),
    undefined,
  );
});

Deno.test("complete call metadata orders rows by start, owns one turn span and prices each stored call without tool-output retention", () => {
  const a = { ...step("z"), time: { created: 1000, completed: 3000 } };
  const b = { ...step("a", "two"), time: { created: 4000, completed: 7000 } };
  const c = { ...step("final"), time: { created: 8000, completed: 12000 } };
  a.parts = [{
    kind: "tool",
    id: "tool",
    call: {
      tool: "bash",
      callID: "call",
      title: "Inspect files",
      command: "ls -la",
      output: "secret-output",
      status: "completed",
      awaitingPermission: false,
      time: { start: 1500, end: 2000 },
    },
  }];
  const ledger = new UsageLedger("s", [b, c, a].map(usageHeader));
  const snapshot = ledger.snapshot();
  const turn = turnUsage(snapshot, c, catalog)!;
  assertEquals(turn.time, { start: 1000, end: 12000 });
  assertEquals(turn.calls.map((call) => call.id), ["z", "a", "final"]);
  assertEquals(turn.calls.map((call) => call.activity), [
    "bash: Inspect files",
    "answered",
    "answered",
  ]);
  assertEquals(turn.calls.map((call) => call.time), [
    { start: 1000, end: 3000 },
    { start: 4000, end: 7000 },
    { start: 8000, end: 12000 },
  ]);
  assertEquals(turn.calls.map((call) => call.tokens), [240000, 240000, 240000]);
  assertAlmostEquals(turn.calls[1].categories[0].cost!, .4);
  assertAlmostEquals(
    turn.cost,
    turn.calls.reduce((sum, call) => sum + call.cost, 0),
  );
  assertEquals(JSON.stringify(snapshot).includes("secret-output"), false);
  ledger.tool("z", { id: "tool", name: "bash", summary: "Updated label" });
  ledger.upsert(usageHeader({ ...a, parts: [] }));
  assertEquals(
    snapshot.messages[0].tools?.[0].summary,
    "Inspect files",
    "Published snapshots stay detached",
  );
  assertEquals(
    turnUsage(ledger.snapshot(), c)?.calls[0].activity,
    "bash: Updated label",
  );
  ledger.removeTool("z", "tool");
  assertEquals(turnUsage(ledger.snapshot(), c)?.calls[0].activity, "answered");
  ledger.upsert(usageHeader({ ...step("live"), time: { created: 13000 } }));
  assertEquals(ledger.snapshot().turns.user.time, {
    start: 1000,
    end: undefined,
  });
  ledger.remove("live");
  assertEquals(ledger.snapshot().turns.user.time, { start: 1000, end: 12000 });
});

Deno.test("a queued user message cannot split the charged turn, and session identity isolates matching parent IDs", () => {
  const messages = [
    step("a"),
    {
      id: "queued",
      sessionID: "s",
      role: "user" as const,
      time: { created: 2 },
      parts: [],
    },
    step("b", "two"),
    { ...step("elsewhere"), sessionID: "other" },
  ];
  const usage = replyUsage(messages, catalog);
  assertEquals([...usage.keys()], ["a", "elsewhere"]);
  assertEquals(usage.get("a")!.tokens, 480000);
  assertEquals(usage.get("elsewhere")!.tokens, 240000);
  assertEquals(replyMessages(messages).map((m) => m.id), [
    "a",
    "queued",
    "elsewhere",
  ]);
  assertEquals([...replyMetadata(messages).keys()], ["b", "elsewhere"]);
});
