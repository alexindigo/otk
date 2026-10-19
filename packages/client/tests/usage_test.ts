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
