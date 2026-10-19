// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { contextMeter } from "@otk/client";
import type { AssistantMessage, ModelCatalog } from "@otk/protocol";
Deno.test("context meter uses latest footprint without aggregating charged usage and never invents a window", () => {
  const reply = (
    id: string,
    input: number,
    cost: number,
  ): AssistantMessage => ({
    id,
    sessionID: "s",
    role: "assistant",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: 1 },
    parts: [],
    interrupted: false,
    tokens: { input, output: 20, reasoning: 3, cache: { read: 100, write: 5 } },
    cost,
  });
  assertEquals(contextMeter([]), {});
  assertEquals(contextMeter([reply("a", 1000, .1), reply("b", 2000, .2)]), {
    tokens: 2128,
  });
  const empty = reply("c", 0, 0);
  empty.tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  assertEquals(contextMeter([reply("a", 1000, .1), empty]), {
    tokens: 1128,
  });
});

Deno.test("context window matches the reported footprint's exact provider/model, not catalog defaults or a later empty step", () => {
  const message: AssistantMessage = {
    id: "used",
    sessionID: "s",
    role: "assistant",
    agent: "build",
    model: { provider: "opencode", model: "beam-free" },
    time: { created: 1 },
    tokens: {
      input: 2000,
      output: 100,
      reasoning: 20,
      cache: { read: 300, write: 80 },
    },
    cost: 0,
    parts: [],
    interrupted: false,
  };
  const catalog: ModelCatalog = {
    default: { provider: "other", model: "beam-free" },
    providers: ["other", "opencode"].map((id) => ({
      id,
      name: id,
      models: [{
        id: "beam-free",
        name: "Beam Free",
        free: id === "opencode",
        variants: [],
        status: "active",
        contextLimit: id === "opencode" ? 10000 : 20000,
      }],
    })),
  };
  const empty: AssistantMessage = {
    ...message,
    id: "empty",
    model: { provider: "other", model: "beam-free" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  assertEquals(contextMeter([message, empty], catalog), {
    tokens: 2500,
    limit: 10000,
    fraction: .25,
  });
  assertEquals(
    contextMeter([message, { ...message, model: empty.model }], catalog),
    { tokens: 2500, limit: 20000, fraction: .125 },
  );
  for (const limit of [undefined, 0, -1, NaN, Infinity]) {
    catalog.providers[1].models[0].contextLimit = limit;
    assertEquals(contextMeter([message], catalog), { tokens: 2500 });
  }
  catalog.providers[1].models[0].contextLimit = 1000;
  assertEquals(contextMeter([message], catalog), {
    tokens: 2500,
    limit: 1000,
    fraction: 1,
  });
  assertEquals(
    contextMeter([{
      ...message,
      model: { provider: "missing", model: "beam-free" },
    }], catalog),
    { tokens: 2500 },
  );
  assertEquals(contextMeter([], catalog), {});
});
