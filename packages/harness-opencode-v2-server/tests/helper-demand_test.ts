// SPDX-License-Identifier: LGPL-3.0-only
import { knownDerived } from "@otk/protocol";
import { assertEquals, assertRejects } from "@std/assert";
import { Messages, type NativeMessage, SCAN_ROWS } from "../messages.ts";
import { TranscriptReads } from "../transcript-reads.ts";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";
import type { ContentOp, HelperSummary, MessagePolicy } from "@otk/protocol";

const policy: MessagePolicy = {
  prefetchms: 0,
  prefetchbytes: 0,
  coolms: 1,
  preloadms: 1,
  concurrency: 2,
  replayops: 128,
  replaybytes: 1048576,
  recoveryconcurrency: 2,
  recoverypending: 32,
  retryms: 100,
};
const toolMessage = (id: string): NativeMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "fake", id: "scripted" },
  content: [{
    type: "tool",
    id: "call",
    name: "shell",
    state: { status: "running", input: {}, metadata: { title: "Probe" } },
    time: { created: 10 },
  }],
  time: { created: 1 },
});

Deno.test("V2 demanded helper API reads bounded pages, yields, normalizes names and cancels", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = {
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        message: {
          list: (input: Record<string, unknown>) => {
            requests.push(input);
            return Promise.resolve({
              data: input.cursor ? [toolMessage("last")] : Array.from(
                { length: SCAN_ROWS },
                (_, i) => toolMessage(String(i)),
              ),
              cursor: { next: input.cursor ? undefined : "older" },
            });
          },
        },
      }),
  } as unknown as V2Client;
  let yields = 0;
  const reads = new TranscriptReads(
    new Messages(() => client),
    () => undefined,
    (signal) => {
      yields++;
      signal.throwIfAborted();
      return Promise.resolve();
    },
  );
  assertEquals(
    await reads.helperProgress("opcv2-ses_child", new AbortController().signal),
    {
      state: "ready",
      revision: 0,
      progress: knownDerived(
        {
          toolCount: SCAN_ROWS + 1,
          current: { name: "bash", title: "Probe", startedAt: 10 },
        },
        "opcv2-ses_child",
        0,
      ),
    },
  );
  assertEquals(requests.map((r) => [r.limit, r.order, r.cursor]), [[
    SCAN_ROWS,
    "desc",
    undefined,
  ], [SCAN_ROWS, undefined, "older"]]);
  assertEquals(yields, 1);
  const controller = new AbortController();
  const cancel = new TranscriptReads(
    new Messages(() => client),
    () => undefined,
    () => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    },
  );
  const before = requests.length;
  await assertRejects(
    () => cancel.helperProgress("opcv2-ses_child", controller.signal),
    DOMException,
  );
  assertEquals(requests.length - before, 1);
});

Deno.test("V2 helper demand starts only for acquired parent links and cancels with the last viewer", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const late = Promise.withResolvers<unknown>();
  let reads = 0;
  const client = {
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        message: {
          list: (_input: unknown, options: { signal: AbortSignal }) => {
            reads++;
            entered.resolve(options.signal);
            return late.promise;
          },
        },
      }),
  } as unknown as V2Client;
  const events: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => client,
    policy,
    content: (_id, event) => events.push(event),
    diagnostic() {},
    invalidated() {},
  });
  const child = {
    sessionID: "ses_child",
    assistantMessageID: "msg_child",
    id: "call",
    name: "shell",
  };
  await transcript.event({ type: "session.tool.called", data: child });
  assertEquals(reads, 0);
  transcript.subscriptions("opcv2-ses_parent", 1);
  await transcript.event({
    type: "session.step.started",
    data: {
      sessionID: "ses_parent",
      assistantMessageID: "msg_parent",
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
    },
  });
  for (
    const [type, data] of [
      ["session.tool.input.started", { name: "subagent" }],
      ["session.tool.called", { input: { agent: "general" } }],
      ["session.tool.progress", { metadata: { sessionID: "ses_child" } }],
    ] as const
  ) {
    await transcript.event({
      type,
      data: {
        sessionID: "ses_parent",
        assistantMessageID: "msg_parent",
        id: "parent-call",
        ...data,
      },
    });
  }
  const signal = await entered.promise;
  assertEquals(reads, 1);
  transcript.subscriptions("opcv2-ses_parent", 2);
  transcript.subscriptions("opcv2-ses_parent", 1);
  assertEquals(signal.aborted, false);
  transcript.subscriptions("opcv2-ses_parent", 0);
  assertEquals(signal.aborted, true);
  late.resolve({ data: [toolMessage("late")], cursor: {} });
  await transcript.stop();
  assertEquals(events.filter((event) => event.op === "task.progress"), []);
  await transcript.event({ type: "session.tool.called", data: child });
  assertEquals(reads, 1);
});

Deno.test("V2 acquired helper progress stays coherent through held refresh and source outage", async () => {
  const first = Promise.withResolvers<HelperSummary>(),
    failed = Promise.withResolvers<HelperSummary>(),
    recovered = Promise.withResolvers<HelperSummary>(),
    unchanged = Promise.withResolvers<HelperSummary>(),
    coalesced = Promise.withResolvers<HelperSummary>(),
    secondEntered = Promise.withResolvers<void>(),
    secondHeld = Promise.withResolvers<
      { data: NativeMessage[]; cursor: Record<string, never> }
    >(),
    entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<never>();
  let reads = 0, errors = 0;
  const client = {
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        message: {
          list: () => {
            if (++reads === 1) {
              return Promise.resolve({
                data: [toolMessage("one")],
                cursor: {},
              });
            }
            if (reads === 2) {
              entered.resolve();
              return held.promise;
            }
            if (reads === 5) {
              secondEntered.resolve();
              return secondHeld.promise;
            }
            if (reads >= 6) {
              return Promise.resolve({
                data: [
                  toolMessage("one"),
                  toolMessage("two"),
                  toolMessage("three"),
                ],
                cursor: {},
              });
            }
            return Promise.resolve({
              data: [toolMessage("one"), toolMessage("two")],
              cursor: {},
            });
          },
        },
      }),
  } as unknown as V2Client;
  const events: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => client,
    policy,
    invalidated() {},
    diagnostic() {
      errors++;
    },
    content: (_id, event) => {
      events.push(event);
      if (event.op === "task.progress") {
        if (event.summary.state === "ready") first.resolve(event.summary);
        if (event.summary.state === "ready" && reads === 3) {
          recovered.resolve(event.summary);
        }
        if (event.summary.state === "ready" && reads === 4) {
          unchanged.resolve(event.summary);
        }
        if (event.summary.state === "ready" && reads === 6) {
          coalesced.resolve(event.summary);
        }
        if (event.summary.state === "unavailable") {
          failed.resolve(event.summary);
        }
      }
    },
  });
  try {
    transcript.subscriptions("opcv2-ses_parent", 1);
    await transcript.event({
      type: "session.step.started",
      data: {
        sessionID: "ses_parent",
        assistantMessageID: "msg_parent",
        agent: "build",
        model: { providerID: "fake", id: "scripted" },
      },
    });
    for (
      const [type, data] of [
        ["session.tool.input.started", { name: "subagent" }],
        ["session.tool.called", { input: { agent: "general" } }],
        ["session.tool.progress", { metadata: { sessionID: "ses_child" } }],
      ] as const
    ) {
      await transcript.event({
        type,
        data: {
          sessionID: "ses_parent",
          assistantMessageID: "msg_parent",
          id: "parent-call",
          ...data,
        },
      });
    }
    const before = await first.promise;
    transcript.helper("opcv2-ses_child", before);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      reads,
      2,
      "refresh admitted as a read retires must not be lost",
    );
    await entered.promise;
    const updates = events.filter((event) => event.op === "task.progress");
    assertEquals(updates.length, 1);
    held.reject(new Error("source offline"));
    const stale = await failed.promise;
    assertEquals(stale.progress, before.progress);
    assertEquals(errors, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    transcript.helper("opcv2-ses_child", stale);
    const fresh = await recovered.promise;
    assertEquals(
      fresh.progress.state === "known" && fresh.progress.value.toolCount,
      2,
    );
    assertEquals(
      fresh.progress.state === "known" && fresh.progress.witness.revision,
      (before.progress.state === "known"
        ? before.progress.witness.revision
        : -1) + 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    transcript.helper("opcv2-ses_child", fresh);
    assertEquals(
      (await unchanged.promise).progress,
      fresh.progress,
      "unchanged viewer refresh must retain its semantic witness",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const start = events.length;
    transcript.helper("opcv2-ses_child", fresh);
    await secondEntered.promise;
    transcript.helper("opcv2-ses_child", fresh);
    secondHeld.resolve({ data: [toolMessage("obsolete")], cursor: {} });
    const latest = await coalesced.promise;
    assertEquals(
      latest.progress.state === "known" && latest.progress.value.toolCount,
      3,
    );
    assertEquals(
      events.slice(start).filter((event) => event.op === "task.progress").map((
        event,
      ) =>
        event.summary.progress.state === "known" &&
        event.summary.progress.value.toolCount
      ),
      [3],
      "a raced refresh cannot publish its incomplete replacement",
    );
  } finally {
    if (reads >= 2) held.reject(new Error("retired"));
    secondHeld.resolve({ data: [], cursor: {} });
    await transcript.stop();
  }
});
