// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { UsageLedger, type UsageMessage } from "@otk/protocol";

const unknown = {
  input: null,
  output: null,
  reasoning: null,
  cache: { read: null, write: null },
};
const zero = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
const call = (id: string, reported: boolean): UsageMessage => ({
  id,
  turnID: "turn",
  model: { provider: "fake", model: "scripted" },
  completed: true,
  cost: reported ? 0 : null,
  tokens: reported ? zero : unknown,
});
Deno.test("usage authority follows reported constituents through replacement and removal", () => {
  const ledger = new UsageLedger("s", [call("unknown", false)], "reported");
  assertEquals(ledger.summary("turn")?.cost, null);
  assertEquals(ledger.summary()?.tokens, unknown);
  ledger.upsert(call("reported", true));
  for (const turn of [undefined, "turn"]) {
    assertEquals(ledger.summary(turn)?.cost, 0);
    assertEquals(ledger.summary(turn)?.tokens, zero);
    assertEquals(ledger.summary(turn)?.contextPeak, 0);
  }
  assertEquals(
    ledger.detail("turn").calls.find((value) => value.id === "unknown")?.cost,
    null,
  );
  ledger.upsert(call("reported", false));
  assertEquals(ledger.summary("turn")?.cost, null);
  ledger.upsert(call("reported", true));
  ledger.remove("reported");
  assertEquals(ledger.summary("turn")?.cost, null);
  ledger.remove("unknown");
  assertEquals(ledger.detail("turn").summary.tokens, unknown);
  assertEquals(ledger.summary()?.cost, null);
});

Deno.test("usage omitted metadata belongs only to the same admitted run", () => {
  const timing = { state: "known", start: 10, end: 20, workingMs: 10 } as const;
  const original: UsageMessage = {
    ...call("a", true),
    time: { start: 10, end: 20 },
    timing,
    tools: [{ id: "tool", name: "read" }],
  };
  for (const change of ["refresh", "restart", "move", "start"] as const) {
    const ledger = new UsageLedger("s", [original]);
    const next = {
      ...call("a", true),
      ...(change === "move" ? { turnID: "other" } : {}),
      ...(change === "start" ? { time: { start: 30 } } : {}),
    };
    ledger.upsert(next, change === "restart");
    const admitted = ledger.call("a")!;
    assertEquals(
      admitted.timing,
      change === "refresh" ? timing : undefined,
      change,
    );
    assertEquals(
      admitted.time,
      change === "refresh" ? original.time : next.time,
      change,
    );
    assertEquals(
      admitted.tools,
      change === "refresh" ? original.tools : [],
      change,
    );
  }
});

Deno.test("usage timing tracks changed clock evidence while same-run tools survive", () => {
  const original: UsageMessage = {
    ...call("a", true),
    time: { start: 10, end: 20 },
    timing: { state: "known", start: 10, end: 20, workingMs: 10 },
    tools: [{ id: "tool", name: "read" }],
  };
  const ledger = new UsageLedger("s", [original]);
  const { timing: _timing, tools: _tools, ...next } = original;
  ledger.upsert({ ...next, time: { start: 10, end: 30 } });
  assertEquals(ledger.call("a")?.timing, undefined);
  assertEquals(ledger.call("a")?.tools, original.tools);
  const renewed = {
    state: "known",
    start: 10,
    end: 30,
    workingMs: 15,
  } as const;
  ledger.upsert({ ...next, time: { start: 10, end: 30 }, timing: renewed });
  assertEquals(ledger.call("a")?.timing, renewed);
});
