// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue, knownDerived } from "@otk/protocol";
import { assertEquals } from "@std/assert";
import type {
  AssistantMessage,
  ModelCatalog,
  UsageSummary,
} from "@otk/protocol";
import {
  deletedFacts,
  reportedTokens,
  sessionSummary,
  summaryMeter,
} from "../session-summary.ts";
import { shellEntry } from "./shell-fixture.ts";

const total: UsageSummary = {
  calls: 3,
  cost: .125,
  tokens: {
    input: 1000,
    output: 20,
    reasoning: 5,
    cache: { read: 100, write: 10 },
  },
  contextPeak: 600,
};
Deno.test("turn summaries come from the keyed index, never the loaded reply's partial usage", () => {
  const entry = shellEntry("tstv1-one");
  entry.digest = {
    state: "ready",
    revision: 2,
    turns: { turn: knownDerived(total, "turn", 2) },
    total: knownDerived(total, "session", 2),
  };
  const reply: AssistantMessage = {
    id: "reply",
    sessionID: entry.id,
    replyTo: "turn",
    role: "assistant",
    agent: "build",
    model: { provider: "p", model: "m" },
    time: { created: 1 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [],
  };
  assertEquals(sessionSummary(entry, reply)?.calls, 3);
  assertEquals(sessionSummary(entry, reply)?.tokens.input, 1000);
  assertEquals(sessionSummary(entry, reply)?.cost, .125);
  assertEquals(reportedTokens({ ...total.tokens, input: null }), undefined);
  assertEquals(reportedTokens(reply.tokens), 0);
});

Deno.test("the meter uses the latest reported context and model, with no invented unready footprint", () => {
  const entry = shellEntry("tstv1-one");
  entry.digest = {
    state: "ready",
    revision: 2,
    turns: {},
    total: knownDerived(total, "session", 2),
    last: knownDerived(
      {
        callID: "call",
        model: { provider: "p", model: "m" },
        context: {
          input: 20,
          output: 3,
          reasoning: 2,
          cache: { read: 4, write: 1 },
        },
      },
      "call",
      2,
    ),
  };
  const catalog: ModelCatalog = {
    defaultState: "unknown",
    providers: [{
      id: "p",
      name: "Provider",
      models: [{
        id: "m",
        name: "Model",
        variants: [],
        status: "active",
        free: false,
        contextLimit: 100,
      }],
    }],
  };
  assertEquals(summaryMeter(entry, catalog), {
    tokens: 30,
    limit: 100,
    fraction: .3,
  });
  entry.digest.state = "digesting";
  assertEquals(summaryMeter(entry, catalog), {
    tokens: 30,
    limit: 100,
    fraction: .3,
  });
});

Deno.test("deleted facts share display money and exact accessibility, and cost off removes both", () => {
  const entry = shellEntry("tstv1-one");
  entry.digest = {
    state: "ready",
    revision: 2,
    turns: {},
    total: knownDerived(structuredClone(total), "session", 2),
  };
  for (
    const [amount, display, exact] of [[0, "$0.00", "$0"], [
      .00000005,
      "<$0.01",
      "$0.00000005",
    ], [.125, "$0.13", "$0.125"]] as const
  ) {
    derivedValue(entry.digest.total)!.cost = amount;
    const fact = deletedFacts(entry, true, String).find((fact) =>
      fact.label === "Reported cost"
    );
    assertEquals(fact?.value, display);
    assertEquals(
      fact && Reflect.get(fact, "description"),
      `Exact cost: ${exact}`,
    );
  }
  assertEquals(
    deletedFacts(entry, false, String).some((fact) =>
      fact.value.includes("$") ||
      String(Reflect.get(fact, "description") ?? "").includes("$")
    ),
    false,
  );
});
