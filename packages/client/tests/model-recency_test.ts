// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ModelRef } from "@otk/protocol";
import { createModelRecency } from "../model-preferences.ts";

Deno.test("native applied models serialize recency independently of unknown catalogs and later choices", async () => {
  let recent: ModelRef[] = [];
  const calls: ModelRef[][] = [], failures: unknown[] = [];
  const first = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>();
  const record = createModelRecency({
    get: () => recent,
    set: async (value) => {
      calls.push(value);
      await (calls.length === 1 ? first : second).promise;
      recent = value;
    },
    fail: (cause) => failures.push(cause),
  });
  record({});
  const applied = { provider: "native", model: "applied-default" };
  record({ model: applied });
  applied.model = "later-picker-choice";
  record({ model: { provider: "native", model: "next-send" } });
  await Promise.resolve();
  assertEquals(calls, [[{ provider: "native", model: "applied-default" }]]);
  first.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(calls[1], [{ provider: "native", model: "next-send" }, {
    provider: "native",
    model: "applied-default",
  }]);
  second.reject("preference refusal");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(failures, ["preference refusal"]);
  record({ model: { provider: "native", model: "after-refusal" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(calls[2], [{ provider: "native", model: "after-refusal" }, {
    provider: "native",
    model: "applied-default",
  }]);
});
