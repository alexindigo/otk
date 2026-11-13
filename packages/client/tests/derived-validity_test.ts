// SPDX-License-Identifier: LGPL-3.0-only
import { knownDerived } from "@otk/protocol";
import { assertEquals } from "@std/assert";
import { sessionSummary, summaryMeter } from "../session-summary.ts";
import { createSessionActions } from "../session-actions.ts";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

Deno.test("refresh activity cannot revoke an already reported context value", () => {
  const entry = shellEntry("tstv1-one");
  entry.digest = {
    state: "ready",
    revision: 2,
    turns: {},
    last: knownDerived(
      {
        callID: "call",
        context: {
          input: 20,
          output: 3,
          reasoning: 2,
          cache: { read: 4, write: 1 },
        },
      },
      "call",
      1,
    ),
  };
  const known = summaryMeter(entry);
  assertEquals(known.tokens, 30);
  entry.digest.state = "digesting";
  entry.digest.revision++;
  assertEquals(summaryMeter(entry), known);
});

Deno.test("header summary belongs to the selected child, not its contextual parent", () => {
  const f = shellFixture();
  try {
    const root = shellEntry("root"),
      child = shellEntry("selected", "/p", "root");
    const zero = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    root.digest = {
      state: "ready",
      revision: 1,
      turns: {},
      total: knownDerived(
        { calls: 10, cost: 1191.18, tokens: zero, contextPeak: 0 },
        "root",
        1,
      ),
    };
    child.digest = {
      state: "ready",
      revision: 1,
      turns: {},
      last: knownDerived(
        { callID: "child-call", context: zero },
        "child-call",
        1,
      ),
      total: knownDerived(
        { calls: 3, cost: 0, tokens: zero, contextPeak: 0 },
        "child",
        1,
      ),
    };
    f.entries("local", [root, child]);
    const selected = createSessionActions(f).selectedEntry();
    assertEquals(selected?.id, child.id);
    assertEquals(summaryMeter(selected).tokens, 0);
    assertEquals(sessionSummary(selected)?.cost, 0);
    assertEquals(
      sessionSummary(f.resources.entry("local", root.id))?.cost,
      1191.18,
    );
  } finally {
    f.resources.stop();
  }
});
