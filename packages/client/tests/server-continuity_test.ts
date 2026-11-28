// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  graceElapsed,
  lost,
  outdated,
  reached,
  refused,
  type ServerContinuity,
  welcomed,
} from "../server-continuity.ts";

Deno.test("one outage survives retries, escalates once and is cleared by reachability", () => {
  const away = lost({ kind: "live" }, 10);
  assertEquals(away, { kind: "away", since: 10 });
  assertStrictEquals(lost(away, 99), away);
  const offline = graceElapsed(away);
  assertEquals(offline, { kind: "unreachable", since: 10 });
  assertStrictEquals(lost(offline, 100), offline);
  assertStrictEquals(graceElapsed(offline), offline);
  assertEquals(reached(offline), { kind: "live" });
  assertEquals(reached(away), { kind: "live" });
  assertEquals(refused(offline, "probe failed"), {
    kind: "unreachable",
    since: 10,
    refused: "probe failed",
  });
  assertEquals(refused(refused(offline, "probe failed")), {
    kind: "unreachable",
    since: 10,
    refused: undefined,
  });
});

Deno.test("only the page's own build can become terminally outdated by a welcome", () => {
  const a = { build: "a", instance: "one" };
  const restarted = { build: "a", instance: "two" };
  const upgraded = { build: "b", instance: "three" };
  const offline: ServerContinuity = { kind: "unreachable", since: 1 };
  const first = welcomed(offline, {}, a);
  assertEquals(first, {
    state: { kind: "live" },
    memory: { baseline: a, current: a },
  });
  assertEquals(welcomed(offline, first.memory, a), first);
  assertEquals(welcomed(offline, first.memory, restarted), {
    state: { kind: "live", restarted: { instance: "two", updated: false } },
    memory: { baseline: a, current: restarted },
  });
  assertEquals(welcomed(offline, first.memory, upgraded), {
    state: { kind: "live", restarted: { instance: "three", updated: true } },
    memory: { baseline: upgraded, current: upgraded },
  });
  for (const page of [{ build: "a" }, {}]) {
    const memory = { ...first.memory, page };
    const change = welcomed(offline, memory, upgraded);
    assertEquals(change, {
      state: { kind: "updated", build: "b" },
      memory: { page, baseline: a, current: upgraded },
    });
    assertStrictEquals(lost(change.state, 20), change.state);
    assertStrictEquals(outdated(change.state, { protocol: 999 }), change.state);
    assertEquals(welcomed(change.state, change.memory, a), {
      state: change.state,
      memory,
    });
  }
  assertEquals(welcomed(offline, { page: { build: "a" } }, upgraded).state, {
    kind: "updated",
    build: "b",
  });
});
