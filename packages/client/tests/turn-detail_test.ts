// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { UsageLedger, type UsageMessage } from "@otk/protocol";
import type { TurnUsageDetail } from "@otk/protocol";
import { createSessionUsage } from "../session-usage.ts";
import { SidecarConnection } from "../connection.ts";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";

const call = (id: string, input: number | null): UsageMessage => ({
  id,
  turnID: "turn",
  model: { provider: "test", model: "test" },
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: input,
  completed: true,
  time: { start: 1, end: 2 },
});
Deno.test("usage preserves unknown contributors through keyed replacements and removal", () => {
  const ledger = new UsageLedger("tstv1-s", [
    call("known", 5),
    call("unknown", null),
  ]);
  assertEquals(ledger.snapshot().turns.turn.tokens.input, null);
  assertEquals(ledger.snapshot().turns.turn.cost, null);
  ledger.upsert(call("unknown", 0));
  assertEquals(ledger.snapshot().turns.turn.tokens.input, 5);
  ledger.upsert(call("unknown", null));
  ledger.remove("known");
  assertEquals(ledger.snapshot().turns.turn.tokens.input, null);
  ledger.upsert(call("unknown", 0));
  assertEquals(ledger.snapshot().turns.turn.tokens.input, 0);
});
Deno.test("usage mutations expose only changed calls and turns without a detached snapshot", () => {
  const ledger = new UsageLedger("tstv1-s", [call("a", 1), call("b", 2)]);
  const unchanged = ledger.call("a");
  const change = ledger.upsert(call("b", 4));
  assertEquals(change.calls.upsert.map((item) => item.id), ["b"]);
  assertEquals(change.turns, ["turn"]);
  assertStrictEquals(ledger.call("a"), unchanged);
  assertEquals(ledger.turn("turn")?.tokens.input, 5);
  assertEquals(ledger.remove("b").calls.remove, ["b"]);
  assertEquals(ledger.turn("turn")?.tokens.input, 1);
  ledger.tool("a", { id: "tool", name: "bash" });
  const labelled = ledger.call("a");
  assertEquals(ledger.tool("a", { id: "tool", name: "bash" }).turns, []);
  assertEquals(ledger.removeTool("a", "not-a-tool").turns, []);
  assertStrictEquals(ledger.call("a"), labelled);
});

Deno.test("held detail replay projects headers and tool labels without reading or retaining transcript source", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.supports = () => true;
  const held = Promise.withResolvers<TurnUsageDetail>();
  connection.rpc.call = () => held.promise as never;
  const owner = createSessionUsage(() => connection),
    target = { sidecarId: "server", sessionID: "tstv1-s", turnID: "turn" };
  const release = owner.retain(target);
  try {
    const pending = owner.load(target);
    await Promise.resolve();
    let sourceReads = 0;
    owner.receive("server", {
      t: "content",
      sessionID: "tstv1-s",
      clock: { epoch: "test", seq: 1 },
      event: {
        op: "message.upsert",
        message: {
          ...call("a", 7),
          role: "assistant",
          replyTo: "turn",
          sessionID: "tstv1-s",
          agent: "build",
          interrupted: false,
          time: { created: 1, completed: 2 },
          parts: [{
            kind: "text",
            id: "text",
            synthetic: false,
            get blocks(): import("@otk/protocol").Block[] {
              sourceReads++;
              return [{
                b: "paragraph",
                inline: [{
                  i: "text",
                  text: "Transcript source belongs only to its body resource",
                }],
              }];
            },
          }],
        },
      },
    });
    assertEquals(sourceReads, 0);
    held.resolve({
      ...new UsageLedger("tstv1-s", [call("a", 0)]).detail("turn"),
      version: { generation: 0, revision: 0 },
      clock: { epoch: "test", seq: 0 },
    });
    await pending;
    assertEquals(owner.get(target)?.summary.tokens.input, 7);
    assertEquals(sourceReads, 0);
  } finally {
    release();
    owner.stop();
    connection.stop();
  }
});

Deno.test("opened detail ignores duplicate clocks and replaces a foreign epoch through one fresh targeted read", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.supports = () => true;
  let reads = 0;
  connection.rpc.call = () =>
    Promise.resolve({
      ...new UsageLedger("tstv1-s", [call("a", ++reads === 1 ? 5 : 7)]).detail(
        "turn",
      ),
      clock: { epoch: reads === 1 ? "old" : "new", seq: reads === 1 ? 5 : 1 },
    }) as never;
  const owner = createSessionUsage(() => connection),
    target = { sidecarId: "server", sessionID: "tstv1-s", turnID: "turn" };
  const release = owner.retain(target);
  const emit = (input: number, seq: number, epoch = "old") =>
    owner.receive("server", {
      t: "content",
      sessionID: "tstv1-s",
      clock: { epoch, seq },
      event: {
        op: "message.upsert",
        message: {
          ...call("a", input),
          role: "assistant",
          replyTo: "turn",
          sessionID: "tstv1-s",
          agent: "build",
          interrupted: false,
          time: { created: 1, completed: 2 },
          parts: [],
        },
      },
    });
  try {
    await owner.load(target);
    emit(6, 6);
    emit(4, 5);
    emit(3, 6);
    assertEquals(owner.get(target)?.summary.tokens.input, 6);
    emit(99, 1, "new");
    await owner.load(target);
    assertEquals(reads, 2);
    assertEquals(owner.get(target)?.summary.tokens.input, 7);
  } finally {
    release();
    owner.stop();
    connection.stop();
  }
});

Deno.test("closed details acquire nothing; an opened turn prices only changed calls and never snapshots on a live mutation", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  const ledger = new UsageLedger("tstv1-s", [call("a", null), call("b", 2), {
    ...call("other", 99),
    turnID: "other",
  }]);
  const requests: unknown[] = [];
  connection.supports = () => true;
  connection.rpc.call = (_method, params) => {
    requests.push(params);
    return Promise.resolve({
      ...ledger.detail("turn"),
      clock: { epoch: "test", seq: 0 },
    }) as never;
  };
  const owner = createSessionUsage(() => connection);
  const target = { sidecarId: "server", sessionID: "tstv1-s", turnID: "turn" };
  const original = UsageLedger.prototype.snapshot;
  try {
    assertEquals(requests, []);
    const release = owner.retain(target);
    await owner.load(target);
    assertEquals(requests, [{ sessionID: "tstv1-s", turnID: "turn" }]);
    assertEquals(owner.get(target)?.calls.map((call) => call.id), ["a", "b"]);
    const before = owner.priced(target)!;
    UsageLedger.prototype.snapshot = () => {
      throw new Error("ordinary live detail must not snapshot");
    };
    let seq = 0;
    const emit = (input: number | null) =>
      owner.receive("server", {
        t: "content",
        sessionID: "tstv1-s",
        clock: { epoch: "test", seq: ++seq },
        event: {
          op: "message.upsert",
          message: {
            ...call("a", input),
            role: "assistant",
            replyTo: "turn",
            sessionID: "tstv1-s",
            agent: "build",
            interrupted: false,
            time: { created: 1, completed: 2 },
            parts: [],
          },
        },
      });
    emit(null);
    assertEquals(owner.get(target)?.summary.tokens.input, null);
    let historicalVisits = 0;
    const untouched = owner.get(target)!.calls[1];
    Object.defineProperty(untouched, "id", {
      configurable: true,
      get() {
        historicalVisits++;
        return "b";
      },
    });
    emit(0);
    assertEquals(
      historicalVisits,
      0,
      "keyed detail replacement does not inspect historical call records",
    );
    Object.defineProperty(untouched, "id", {
      configurable: true,
      enumerable: true,
      value: "b",
    });
    assertEquals(owner.get(target)?.summary.tokens.input, 2);
    const after = owner.priced(target)!;
    assertStrictEquals(before.calls[1], after.calls[1]);
    assertStrictEquals(after, owner.priced(target));
    emit(5);
    assertEquals(owner.get(target)?.summary.tokens.input, 7);
    release();
    assertEquals(owner.get(target), undefined);
    const count = requests.length;
    emit(10);
    assertEquals(requests.length, count);
  } finally {
    UsageLedger.prototype.snapshot = original;
    owner.stop();
    connection.stop();
  }
});

Deno.test("an overflowed held turn baseline is replaced once instead of replaying an unbounded metadata log", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: { ...fixtureMessagePolicy, retryms: 1 } });
  connection.supports = () => true;
  const held = Promise.withResolvers<TurnUsageDetail>();
  const snapshot = (input: number): TurnUsageDetail => ({
    ...new UsageLedger("tstv1-s", [call("a", input)]).detail("turn"),
    version: { generation: 0, revision: 0 },
    clock: { epoch: "test", seq: 0 },
  });
  let requests = 0;
  connection.rpc.call = () =>
    (++requests === 1
      ? held.promise
      : Promise.resolve(snapshot(10000))) as never;
  const owner = createSessionUsage(() => connection),
    target = { sidecarId: "server", sessionID: "tstv1-s", turnID: "turn" };
  const release = owner.retain(target);
  try {
    const pending = owner.load(target);
    await Promise.resolve();
    for (let i = 0; i < 10000; i++) {
      owner.receive("server", {
        t: "content",
        sessionID: "tstv1-s",
        event: {
          op: "message.upsert",
          message: {
            ...call("a", i),
            role: "assistant",
            replyTo: "turn",
            sessionID: "tstv1-s",
            agent: "build",
            interrupted: false,
            time: { created: 1 },
            parts: [],
          },
        },
      });
    }
    assertEquals(requests, 1);
    held.resolve(snapshot(0));
    await pending;
    assertEquals(owner.get(target), undefined);
    for (let i = 0; requests === 1 && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await owner.load(target);
    assertEquals(requests, 2);
    assertEquals(owner.get(target)?.summary.tokens.input, 10000);
  } finally {
    release();
    owner.stop();
    connection.stop();
  }
});
