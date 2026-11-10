// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProgress, ProgressEstimate } from "../progress.ts";
import type { ProgressFacts } from "@otk/protocol";
const facts = (completed = 0, activeMs = 0): ProgressFacts => ({
  generation: "one",
  phase: "summaries",
  eligible: 100,
  completed,
  activeMs,
  queued: 100 - completed,
  chunks: completed,
  messages: completed * 10,
  started: 0,
  advanced: 1000,
});
Deno.test("ready progress clears pending copy for every resource label", () => {
  const estimate = new ProgressEstimate();
  estimate.update({ ...facts(), phase: "ready" });
  for (
    const label of ["Loading messages", "Loading sessions", "Indexing sessions"]
  ) {
    assertEquals(estimate.display(label, 1000), { busy: false, text: "" });
  }
});
Deno.test("progress estimates steady work from active time, never from waiting", () => {
  const owner = new ProgressEstimate();
  owner.update(facts());
  owner.update(facts(10, 1000));
  assertEquals(owner.display("Summaries", 1000).rate, 10);
  assertEquals(owner.display("Summaries", 1000).eta, [9, 9]);
  owner.update(facts(10, 1000));
  assertEquals(owner.display("Summaries", 30000).eta, [9, 9]);
  owner.update({ ...facts(10, 1000), wait: "native unavailable" });
  const stalled = owner.display("Summaries", 61000);
  assertEquals(stalled.eta, undefined);
  for (
    const copy of [
      "No progress for 1 min",
      "opencode isn't responding",
      "10 of 100",
    ]
  ) assertStringIncludes(stalled.text, copy);
  const page = new ProgressEstimate();
  page.update({
    ...facts(),
    phase: "reading",
    wait: "waiting for the newest page",
  });
  assertEquals(
    page.display("Loading messages", 9000).text,
    "Loading messages...",
  );
  assertEquals(
    page.display("Loading messages", 20000).text,
    "Loading messages... 20 s",
  );
  assertEquals(
    page.display("Loading messages", 61000).text,
    "Still loading messages (1 min): waiting for opencode to respond",
  );
  assertEquals(
    page.display("Loading sessions", 61000).text,
    "Still loading sessions (1 min): waiting for opencode to respond",
  );
});
Deno.test("progress shares human durations for long stalls, page elapsed time and ETA", () => {
  const owner = new ProgressEstimate();
  owner.update(facts());
  assertEquals(
    owner.display("Indexing sessions", 1036863_000).text,
    "Indexing sessions: 0 of 100. No progress for 12 days, waiting for more information",
  );
  owner.update({ ...facts(), phase: "reading" });
  assertEquals(
    owner.display("Loading messages", 1036863_000).text,
    "Still loading messages (12 days): waiting for more information",
  );
  owner.update({ ...facts(), generation: "eta" });
  owner.update({ ...facts(1, 86400_000), generation: "eta" });
  assertEquals(
    owner.display("Indexing sessions", 1000).text,
    "Indexing sessions: 1 of 100, about 99 days left",
  );
});
Deno.test("progress gives bursty rates a range and resets on generation replacement", () => {
  const owner = new ProgressEstimate();
  owner.update(facts());
  owner.update(facts(1, 1000));
  owner.update(facts(21, 2000));
  const range = owner.display("Summaries", 2000).eta!;
  assert(range[1] > range[0]);
  owner.update({ ...facts(21, 2000), generation: "two" });
  assertEquals(owner.display("Summaries", 2000).rate, undefined);
  assertEquals(owner.display("Summaries", 2000).eta, undefined);
  owner.update({ ...facts(22, 3000), generation: "two", eligible: null });
  assertEquals(owner.display("Summaries", 3000).eta, undefined);
  assertEquals(
    owner.display("Indexing sessions", 3000).text,
    "Indexing sessions: 22 found",
  );
});
Deno.test("progress coalesces burst publication and retires its clock when work is ready", async () => {
  const owner = createProgress();
  let publications = 0;
  const release = owner.subscribe(() => publications++);
  try {
    for (let i = 0; i < 20; i++) owner.receive("scope", facts(i, i * 100));
    assertEquals(publications, 0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assertEquals(publications, 1);
    owner.reset("scope");
    owner.receive("scope", { ...facts(20, 2000), phase: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assertEquals(publications, 2);
    assertEquals(owner.display("scope", "Summaries").rate, undefined);
  } finally {
    release();
    owner.stop();
  }
});
