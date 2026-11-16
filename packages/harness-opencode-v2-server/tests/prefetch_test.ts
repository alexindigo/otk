// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { DigestPort } from "@otk/harness";
import type { MessagePolicy } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";
import type { NativeMessage, NativeSession } from "../messages.ts";
import type { PrefetchPage, TranscriptFacts } from "../transcript-reads.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";
import { requestFailureFacts } from "../request-failure.ts";
const id = ids.encode("ses_prefetch");
const policy: MessagePolicy = {
  prefetchms: 10000,
  prefetchbytes: 100000,
  coolms: 1000,
  preloadms: 1000,
  concurrency: 2,
  replayops: 128,
  replaybytes: 1048576,
  recoveryconcurrency: 2,
  recoverypending: 32,
  retryms: 100,
};
const row = (n: number): NativeMessage => ({
  id: `msg_${n}`,
  type: "user",
  text: `prompt-${n}`,
  time: { created: n },
});
const newest = Array.from({ length: 10 }, (_, i) => row(i + 10)),
  older = [row(8), row(9)];
const facts = (rows: NativeMessage[]): TranscriptFacts => ({
  source: "sql:fixture:1",
  contexts: Object.fromEntries(
    rows.map((r) => [r.id, { order: Number(r.id.split("_").at(-1)) }]),
  ),
  metadata: { prompt: { id: "msg_19" }, boundaries: [] },
});
function fixture(
  prefetch?: (signal: AbortSignal) => Promise<PrefetchPage>,
  cover?: () => Promise<TranscriptFacts["metadata"]>,
  rows = newest,
  source = "sql:fixture:1",
  replyTo?: string,
  olderRows = older,
) {
  let bodies = 0, scalars = 0, coverage = 0, failedFacts = false;
  const speculative: { optional?: boolean; priority?: string }[] = [];
  const session = {
    id: "ses_prefetch",
    projectID: "project",
    location: { directory: "/project" },
    title: "prefetch",
    time: { created: 1, updated: 20 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as NativeSession;
  const api = {
    session: {
      get: () => Promise.resolve(session),
      inbox: { list: () => Promise.resolve([]) },
    },
    message: {
      list: (input: { cursor?: string; order?: string }) => {
        bodies++;
        if (input.cursor) assertEquals(input.order, undefined);
        return Promise.resolve({
          data: [...(input.cursor ? olderRows : rows)].reverse(),
          cursor: input.cursor ? {} : { next: "older" },
        });
      },
    },
  };
  const client = {
    service: { version: "2.2.6" },
    failureFacts: requestFailureFacts,
    read: <T>(run: (api: unknown) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const digest = {
    read: (
      kind: string,
      _input: unknown,
      options: { optional?: boolean; priority?: string; signal: AbortSignal },
    ) => {
      if (kind === "opcv2.transcript") {
        scalars++;
        if (failedFacts) {
          return Promise.reject(new Error("Fixture facts unavailable"));
        }
        const input = _input as { messages: string[] };
        return Promise.resolve({
          ...facts(
            [...rows, ...olderRows].filter((row) =>
              input.messages.includes(row.id)
            ),
          ),
          source,
          ...(replyTo
            ? {
              contexts: Object.fromEntries(
                input.messages.map((id) => [id, { order: 19, replyTo }]),
              ),
            }
            : {}),
        });
      }
      speculative.push(options);
      return prefetch ? prefetch(options.signal) : Promise.resolve({
        page: { items: older },
        facts: { ...facts(older), source },
      });
    },
    transcriptMetadata: () => {
      coverage++;
      return cover ? cover() : Promise.resolve(facts(newest).metadata);
    },
    release: () => {},
  } as unknown as DigestPort;
  const recoveries: import("@otk/protocol").PublicFailure[] = [];
  const value = new Transcript({
    client: () => client,
    policy,
    digest,
    content: () => {},
    invalidated: () => {},
    diagnostic: () => {},
    recoveredFailure: (_id, failure) => {
      recoveries.push(failure);
    },
  });
  return {
    value,
    counts: () => ({ bodies, scalars, coverage }),
    speculative,
    recoveries,
    failFacts: (failed: boolean) => {
      failedFacts = failed;
    },
  };
}
Deno.test("recovered failure context enriches archive and durable origin without changing retained identity or position", async () => {
  const error = { type: "APIError", message: "Provider limit", status: 403 };
  const f = fixture(
    undefined,
    undefined,
    [{
      id: "msg_19",
      type: "idle",
      outcome: "failed",
      error,
      time: { created: 19 },
    } as NativeMessage],
    "sql:fixture:1",
    "msg_prompt",
  );
  const key = "failure:execution:evt_19";
  try {
    await f.value.submission(id, "msg_prompt");
    f.failFacts(true);
    const initial = await f.value.executionFailure({
      id: "evt_19",
      type: "session.execution.failed",
      created: 19,
      data: { sessionID: "ses_prefetch", error },
    });
    assertEquals(initial?.facts?.origin, undefined);
    const before = await f.value.requests.get(id, key);
    assert(before?.outcome);
    f.failFacts(false);
    const archive = await f.value.snapshot(id),
      archived = archive.items.find((m) => m.id === before.outcome!.id);
    assert(archived?.role === "context");
    const a = archived.parts[0];
    assert(a.kind === "external");
    assertEquals(a.failure?.facts?.origin, "composer");
    assertEquals(archived.replyTo, "msg_prompt");
    assertEquals(
      await f.value.requests.get(id, key),
      before,
      "Read-only archive must not acquire live retention",
    );
    assertEquals(
      f.recoveries,
      [],
      "Read-only construction cannot publish error observation enrichment",
    );
    const page = await f.value.page(id),
      record = page.items.find((m) => m.id === before.outcome!.id)!;
    assertEquals(page.items.filter((m) => m.id === record.id).length, 1);
    assert(record.role === "context");
    const p = record.parts[0];
    assert(p.kind === "external");
    assertEquals(p.failure?.facts?.origin, "composer");
    assertEquals(p.failure?.diagnosticID, initial?.diagnosticID);
    assertEquals(p.failure?.facts?.record, initial?.facts?.record);
    assertEquals(record.source, before.outcome.source);
    assertEquals(record.time, before.outcome.time);
    const retained = await f.value.requests.get(id, key);
    assertEquals(retained?.position, before.position);
    const part = retained?.outcome?.parts[0];
    assert(part?.kind === "external");
    assertEquals(part.failure?.facts?.origin, "composer");
    assertEquals(f.recoveries.length, 1);
    assertEquals(f.recoveries[0].facts?.origin, "composer");
    await f.value.submission(id, "msg_prompt", "api");
    await f.value.page(id);
    const again = (await f.value.requests.get(id, key))?.outcome?.parts[0];
    assert(again?.kind === "external");
    assertEquals(
      again.failure?.facts?.origin,
      "composer",
      "Already known origin is immutable",
    );
    assertEquals(
      f.recoveries.length,
      1,
      "Unchanged recovery cannot republish an observation",
    );
  } finally {
    await f.value.stop();
  }
});
Deno.test("a retained failure's known parent remains its origin authority when later context disagrees", async () => {
  const error = { type: "APIError", message: "Provider limit", status: 403 };
  const f = fixture(
    undefined,
    undefined,
    [{
      id: "msg_19",
      type: "idle",
      outcome: "failed",
      error,
      time: { created: 19 },
    } as NativeMessage],
    "sql:fixture:1",
    "msg_prompt",
  );
  const key = "failure:execution:evt_19";
  try {
    f.failFacts(true);
    await f.value.executionFailure({
      id: "evt_19",
      type: "session.execution.failed",
      created: 19,
      data: { sessionID: "ses_prefetch", error },
    });
    const retained = await f.value.requests.get(id, key);
    assert(retained?.outcome?.role === "context");
    await f.value.requests.put({
      ...retained,
      outcome: { ...retained.outcome, replyTo: "msg_prior" },
    });
    await f.value.submission(id, "msg_prior", "composer");
    await f.value.submission(id, "msg_prompt", "api");
    f.failFacts(false);
    const record = (await f.value.snapshot(id)).items.find((message) =>
      message.id === retained.outcome!.id
    );
    assert(record?.role === "context");
    assertEquals(record.replyTo, "msg_prior");
    const part = record.parts[0];
    assert(part.kind === "external");
    assertEquals(part.failure?.facts?.origin, "composer");
    assertEquals(f.recoveries, []);
  } finally {
    await f.value.stop();
  }
});
for (const origin of ["composer", "session"] as const) {
  Deno.test(`V2 retained execution failure preserves ${origin} origin through live and page reads`, async () => {
    const error = { type: "APIError", message: "Provider limit", status: 403 };
    const f = fixture(
      undefined,
      undefined,
      [{
        id: "msg_19",
        type: "idle",
        outcome: "failed",
        error,
        time: { created: 19 },
      } as NativeMessage],
      "sql:fixture:1",
      "msg_prompt",
    );
    try {
      if (origin === "composer") await f.value.submission(id, "msg_prompt");
      const live = await f.value.executionFailure({
        id: "evt_19",
        type: "session.execution.failed",
        created: 19,
        data: { sessionID: "ses_prefetch", error },
      });
      assertEquals(
        live?.facts?.origin,
        origin === "composer" ? origin : undefined,
      );
      const page = await f.value.page(id);
      const record = page.items.find((m) =>
        m.id === "request:failure:execution:evt_19"
      );
      assert(record);
      assertEquals(
        record.parts[0].kind === "external" &&
          record.parts[0].failure?.facts?.origin,
        origin === "composer" ? origin : undefined,
      );
      assertEquals((await f.value.requests.page(id, undefined, 10)).length, 1);
    } finally {
      await f.value.stop();
    }
  });
}
for (const source of ["sql:fixture:1", "api:fixture:1"]) {
  for (const archive of [false, true]) {
    Deno.test(`all-failed native pages advance without repeated retained failures: ${source} archive=${archive}`, async () => {
      const rows = newest.map((
        r,
      ) => ({
        id: r.id,
        type: "idle",
        outcome: "failed",
        error: { type: "APIError", message: "Provider limit" },
        time: r.time,
      } as NativeMessage));
      const f = fixture(undefined, undefined, rows, source);
      const messages: string[] = [];
      let before: string | undefined;
      try {
        for (let i = 0; i < 6; i++) {
          const page = archive
            ? await f.value.snapshot(id, before)
            : await f.value.page(id, before);
          assert(page.items.length <= 10);
          for (const m of page.items) {
            assert(!messages.includes(m.id), `Repeated ${m.id}`);
            messages.push(m.id);
          }
          before = page.older ?? undefined;
          if (!before) {
            break;
          }
        }
        assertEquals(before, undefined, "Consumed pages must reach exhaustion");
        assertEquals(messages.length, 12);
        assert(messages.includes("msg_8") && messages.includes("msg_9"));
        assertEquals(
          messages.filter((id) => id.startsWith("request:failure:")).length,
          10,
        );
      } finally {
        await f.value.stop();
      }
    });
  }
}
Deno.test("V2 failed-idle snapshots and later live delivery share one retained failure", async () => {
  const error = { type: "APIError", message: "Provider limit", status: 403 };
  const f = fixture(undefined, undefined, [
    ...newest.slice(0, -1),
    {
      id: "msg_19",
      type: "idle",
      outcome: "failed",
      error,
      time: { created: 19 },
    } as NativeMessage,
  ]);
  try {
    const first = await f.value.page(id);
    const retained = first.items.find((m) =>
      m.id === "request:failure:execution:evt_19"
    );
    assert(retained);
    assertEquals(
      first.items.filter((m) =>
        m.parts.some((p) =>
          p.kind === "external" &&
          (p.failure || p.activity?.title === "Execution failed")
        )
      ).length,
      1,
    );
    assertEquals(retained.sourceOrder, 18.5);
    const live = await f.value.executionFailure({
      id: "evt_19",
      type: "session.execution.failed",
      created: 19,
      data: { sessionID: "ses_prefetch", error },
    }, "prefetch");
    assertEquals(
      retained.parts[0].kind === "external" && retained.parts[0].failure,
      live,
    );
    const again = await f.value.page(id);
    assertEquals(again.items, first.items);
    assertEquals((await f.value.requests.page(id, undefined, 10)).length, 1);
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 snapshot/live failure materialization joins one native identity", async () => {
  const error = { type: "APIError", message: "Provider limit", status: 403 };
  const f = fixture(undefined, undefined, [
    ...newest.slice(0, -1),
    {
      id: "msg_19",
      type: "idle",
      outcome: "failed",
      error,
      time: { created: 19 },
    } as NativeMessage,
  ]);
  try {
    const [first, live] = await Promise.all([
      f.value.page(id),
      f.value.executionFailure({
        id: "evt_19",
        type: "session.execution.failed",
        created: 19,
        data: { sessionID: "ses_prefetch", error },
      }, "prefetch"),
    ]);
    const retained = first.items.find((m) =>
      m.id === "request:failure:execution:evt_19"
    );
    assert(retained);
    assertEquals(
      retained.parts[0].kind === "external" && retained.parts[0].failure,
      live,
    );
    assertEquals((await f.value.page(id)).items, first.items);
    assertEquals((await f.value.requests.page(id, undefined, 10)).length, 1);
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 failed-idle API snapshots do not mistake page-local order for native sequence", async () => {
  const f = fixture(undefined, undefined, [{
    id: "msg_19",
    type: "idle",
    outcome: "failed",
    error: { type: "APIError", message: "Provider limit" },
    time: { created: 19 },
  } as NativeMessage], "api:fixture:1");
  try {
    const page = await f.value.page(id);
    assert(page.items.some((m) => m.id === "request:failure:execution:evt_19"));
    assertEquals(
      (await f.value.requests.get(id, "failure:execution:evt_19"))?.position,
      {
        after: null,
        rank: 0,
        basis: "clock",
      },
    );
    assertEquals(
      await f.value.requests.page(id, undefined, 10, "sequence"),
      [],
    );
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 bounded retained paging preserves native sequence across copied regressing clocks", async () => {
  const f = fixture(
    undefined,
    undefined,
    newest.map((row) => ({
      ...row,
      time: { created: 1000 - row.time.created },
    })),
  );
  try {
    await f.value.requests.put({
      sessionID: id,
      id: "form",
      outcome: {
        id: "request:form",
        sessionID: id,
        role: "context",
        time: { created: 2 },
        parts: [],
      },
      position: { after: 18, rank: 1, basis: "stream" },
    });
    const ids: string[] = [];
    let before: string | undefined;
    do {
      const page = await f.value.page(id, before);
      assert(page.items.length <= 10);
      ids.unshift(...page.items.map((row) => row.id));
      before = page.older ?? undefined;
    } while (before);
    assertEquals(ids, [
      ...Array.from({ length: 11 }, (_, index) => `msg_${index + 8}`),
      "request:form",
      "msg_19",
    ]);
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 API fallback pages equal-clock mixed-case request IDs without gaps or duplicates", async () => {
  const f = fixture(undefined, undefined, newest, "api:fixture:1");
  try {
    const expected = Array.from(
      { length: 26 },
      (_, i) => `request:${String.fromCharCode((i % 2 ? 97 : 65) + i)}`,
    );
    for (const requestID of expected) {
      await f.value.requests.put({
        sessionID: id,
        id: requestID,
        outcome: {
          id: requestID,
          sessionID: id,
          role: "context",
          time: { created: 2000 },
          parts: [],
        },
        position: { after: null, rank: 0, basis: "clock" },
      });
    }
    const actual: string[] = [];
    let before: string | undefined;
    do {
      const page = await f.value.page(id, before);
      assert(page.items.length <= 10);
      actual.push(
        ...page.items.filter((row) => row.role === "context").map((row) =>
          row.id
        ),
      );
      before = page.older ?? undefined;
    } while (before);
    assertEquals(actual.sort(), expected.sort());
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 Q6 prefetch is optional, one successor only, and a hit skips both source reads with fresh replay authority", async () => {
  const f = fixture();
  try {
    const first = await f.value.page(id);
    assert(first.older);
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(f.speculative.length, 1);
    assertEquals(f.speculative[0].optional, true);
    assertEquals(f.speculative[0].priority, "background");
    const before = f.counts();
    f.value.replay.publish(id, { op: "session.error", error: "scalar notice" });
    const second = await f.value.page(id, first.older);
    assertEquals(f.counts(), before);
    assertEquals(second.items.map((r) => r.id), ["msg_8", "msg_9"]);
    assertEquals(second.clock.seq, first.clock.seq + 1);
    assertEquals(f.speculative.length, 1);
    f.value.invalidate(id);
    await assertRejects(() => f.value.page(id, first.older!));
    assertEquals(f.counts(), before);
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 page publishes its body before scalar coverage and never reads that body twice", async () => {
  const gate = Promise.withResolvers<TranscriptFacts["metadata"]>(),
    painted = Promise.withResolvers<void>();
  const f = fixture(undefined, () => gate.promise);
  try {
    let finished = false;
    const page = f.value.page(id, undefined, undefined, () => painted.resolve())
      .then((value) => {
        finished = true;
        return value;
      });
    await painted.promise;
    assertEquals(finished, false);
    assertEquals(f.counts(), { bodies: 1, scalars: 1, coverage: 1 });
    gate.resolve(facts(newest).metadata);
    await page;
    assertEquals(f.counts().bodies, 1);
  } finally {
    gate.resolve(facts(newest).metadata);
    await f.value.stop();
  }
});
Deno.test("V2 mutation cancels speculative ownership and fences a late prefetch result", async () => {
  const gate = Promise.withResolvers<PrefetchPage>();
  let optionalSignal: AbortSignal | undefined;
  const f = fixture((signal) => {
    optionalSignal = signal;
    return gate.promise;
  });
  try {
    const first = await f.value.page(id);
    assert(first.older);
    assert(optionalSignal);
    f.value.changed(id);
    assertEquals(optionalSignal.aborted, true);
    gate.resolve({ page: { items: older }, facts: facts(older) });
    await Promise.resolve();
    await Promise.resolve();
    await f.value.page(id, first.older);
    assertEquals(f.counts().bodies, 2);
    assertEquals(f.counts().scalars, 2);
  } finally {
    gate.resolve({ page: { items: older }, facts: facts(older) });
    await f.value.stop();
  }
});
