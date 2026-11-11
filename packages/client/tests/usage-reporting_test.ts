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
