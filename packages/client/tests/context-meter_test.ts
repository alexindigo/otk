// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { contextMeter } from "@otk/client";
import type { AssistantMessage } from "@otk/protocol";
Deno.test("context meter uses latest reported footprint, sums only reported loaded costs and never invents a window", () => {
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
    cost: .1 + .2,
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
    cost: .1,
  });
});
