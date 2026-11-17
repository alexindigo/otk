// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { DigestPort } from "@otk/harness";
import type { MessagePolicy } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import type { V2Client } from "../client.ts";
import type { NativeMessage, NativeSession } from "../messages.ts";
import type { PrefetchPage, TranscriptFacts } from "../transcript-reads.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";
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
  history = older,
) {
  let bodies = 0, scalars = 0, coverage = 0;
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
          data: [...(input.cursor ? history : rows)].reverse(),
          cursor: input.cursor ? {} : { next: "older" },
        });
      },
    },
  };
  const client = {
    service: { version: "2.2.6" },
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
        const input = _input as { messages: string[] };
        return Promise.resolve({
          ...facts(
            [...rows, ...history].filter((row) =>
              input.messages.includes(row.id)
            ),
          ),
          source,
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
  const value = new Transcript({
    client: () => client,
    policy,
    digest,
    content: () => {},
    invalidated: () => {},
    diagnostic: () => {},
  });
  return {
    value,
    counts: () => ({ bodies, scalars, coverage }),
    speculative,
    session,
    source(value: string) {
      source = value;
    },
  };
}

async function retain(
  f: ReturnType<typeof fixture>,
  name: string,
  created: number,
  after: number | null = null,
) {
  await f.value.requests.put({
    id: name,
    sessionID: id,
    outcome: {
      id: "request:" + name,
      sessionID: id,
      role: "context",
      time: { created },
      parts: [],
    },
    position: after === null
      ? { after, rank: 0, basis: "clock" }
      : { after, rank: f.value.requests.rank(id, after), basis: "stream" },
  });
}

async function collect(f: ReturnType<typeof fixture>) {
  const actual: string[] = [], cursors: Record<string, unknown>[] = [];
  const reads: { index: string | undefined; limit: number }[] = [];
  const page = f.value.requests.page.bind(f.value.requests);
  f.value.requests.page = (sid, before, limit, index) => {
    reads.push({ index, limit });
    assert(limit <= 11, "No population retention scan");
    return page(sid, before, limit, index);
  };
  let identities = 0;
  const get = f.value.requests.get.bind(f.value.requests);
  f.value.requests.get = (sid, key) => {
    identities++;
    return get(sid, key);
  };
  let before: string | undefined;
  do {
    const start = reads.length;
    const keyed = identities, bodies = f.counts().bodies;
    const result = await f.value.page(id, before);
    assert(result.items.length <= 10);
    assert(
      identities - keyed <= 10,
      "Only the bounded pending identity batch is rehydrated",
    );
    assert(
      f.counts().bodies - bodies <= 1,
      "No extra native bodies to repair a retained frontier",
    );
    assert(
      reads.length - start <= 2,
      "At most one batch from each physical index per response",
    );
    actual.push(...result.items.map((m) => m.id));
    before = result.older ?? undefined;
    if (before) {
      assert(before.length <= 4096);
      cursors.push(
        JSON.parse(atob(before.replaceAll("-", "+").replaceAll("_", "/"))),
      );
    }
    assert(
      actual.length <= 200,
      "Duplicate/nonprogressing continuation in finite fixture",
    );
  } while (before);
  return { actual, cursors, reads };
}

Deno.test("V2 SQL overflow never uses an anchored winner's clock to skip an unanchored outcome", async () => {
  const f = fixture(
    undefined,
    undefined,
    newest.map((r) => ({
      ...r,
      time: { created: (Number(r.id.slice(4)) - 9) * 100 },
    })),
  );
  try {
    await retain(f, "anchored", 1, 10);
    await retain(f, "unanchored", 125);
    const { actual } = await collect(f);
    assertEquals(actual.filter((v) => v.startsWith("request:")).sort(), [
      "request:anchored",
      "request:unanchored",
    ]);
    assertEquals(actual.length, 14);
    assertEquals(new Set(actual).size, actual.length);
  } finally {
    await f.value.stop();
  }
});

for (const clocks of ["equal", "nonprefix", "empty"] as const) {
  Deno.test(`V2 independent physical clock batches preserve every identity once: ${clocks}`, async () => {
    const native = clocks === "empty" ? [] : newest.map((r, i) => ({
      ...r,
      time: { created: i === 0 ? 100 : i === 1 ? 1000 : 1 },
    }));
    const f = fixture(
      undefined,
      undefined,
      native,
      "sql:fixture:1",
      clocks === "empty" ? [] : older,
    );
    try {
      const expected = Array.from(
        { length: 37 },
        (_, i) => "request:" + (i % 2 ? "lower" : "UPPER") + i,
      );
      for (let i = 0; i < expected.length; i++) {
        await retain(
          f,
          expected[i].slice(8),
          clocks === "equal" ? 500 : 89 + i,
        );
      }
      if (clocks !== "empty") await retain(f, "copied", 0, 18);
      const { actual, cursors, reads } = await collect(f);
      assertEquals(
        actual.filter((v) => v.startsWith("request:")).sort(),
        [...expected, ...(clocks === "empty" ? [] : ["request:copied"])].sort(),
      );
      assertEquals(new Set(actual).size, actual.length);
      assertEquals(
        actual.filter((v) => !v.startsWith("request:")).sort(),
        clocks === "empty" ? [] : [...newest, ...older].map((r) => r.id).sort(),
      );
      assert(reads.filter((r) => r.index === "unanchored").length >= 4);
      for (const cursor of cursors) {
        const clock = cursor.unanchored as {
          pending: string[];
          before?: { order?: number };
        };
        assert(clock, "Independent physical continuation is required");
        assert(clock.pending.length <= 10);
        assertEquals(
          clock.before?.order,
          undefined,
          "Physical clock state never contains interpolated sequence evidence",
        );
        if (clocks === "empty") {
          assertEquals(
            cursor.retained,
            undefined,
            "Clock-only output cannot certify a native sequence boundary",
          );
        }
      }
    } finally {
      await f.value.stop();
    }
  });
}

for (const change of ["source", "cutoff", "baseline", "placement"] as const) {
  Deno.test(`V2 outstanding mixed-index continuation rejects changed ${change} authority`, async () => {
    const f = fixture();
    try {
      for (let n = 0; n < 15; n++) await retain(f, "mixed" + n, 500 + n);
      const first = await f.value.page(id);
      assert(first.older);
      if (change === "source") f.source("api:replaced");
      if (change === "baseline") f.value.invalidate(id);
      if (change === "cutoff") {
        f.value.observe({ ...f.session, revert: { messageID: "msg_15" } });
      }
      if (change === "placement") await retain(f, "mixed0", 500, 10);
      await assertRejects(() => f.value.page(id, first.older!));
    } finally {
      await f.value.stop();
    }
  });
}
Deno.test("V2 placement change during index capture cannot publish a mixed-generation page", async () => {
  const f = fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const read = f.value.requests.page.bind(f.value.requests);
  f.value.requests.page = async (sid, before, limit, index) => {
    const rows = await read(sid, before, limit, index);
    if (index === "unanchored") {
      entered.resolve();
      await release.promise;
    }
    return rows;
  };
  let published = 0;
  try {
    await retain(f, "moving", 500);
    const pending = f.value.page(id, undefined, undefined, () => published++);
    const rejected = assertRejects(() => pending);
    await entered.promise;
    await retain(f, "moving", 500, 18);
    release.resolve();
    await rejected;
    assertEquals(published, 0);
  } finally {
    release.resolve();
    await f.value.stop();
  }
});

Deno.test("V2 mixed-index continuation rejects malformed physical state without weakening the cursor bound", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 12; n++) await retain(f, "validate" + n, 500 + n);
    const first = await f.value.page(id);
    assert(first.older);
    const cursor = JSON.parse(
      atob(first.older.replaceAll("-", "+").replaceAll("_", "/")),
    );
    const mutations = [
      { ...cursor, v: 2 },
      { ...cursor, revision: -1 },
      { ...cursor, unanchored: { pending: ["one", "one"], exhausted: false } },
      {
        ...cursor,
        unanchored: {
          pending: Array.from({ length: 11 }, (_, i) => String(i)),
          exhausted: false,
        },
      },
      {
        ...cursor,
        unanchored: {
          pending: [],
          exhausted: false,
          before: { created: 1, id: "one", order: 10.5 },
        },
      },
      {
        ...cursor,
        unanchored: {
          pending: [],
          exhausted: false,
          body: "Not continuation state",
        },
      },
    ];
    for (const value of mutations) {
      await assertRejects(() =>
        f.value.page(
          id,
          btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
            .replace(/=+$/, ""),
        )
      );
    }
    await assertRejects(() => f.value.page(id, "a".repeat(4097)));
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

Deno.test("V2 nonprefix clock selection preserves deferred identities instead of replaying a consumed low clock", async () => {
  const native = newest.map((r, i) => ({
    ...r,
    time: { created: i === 0 ? 0 : i === 1 ? 100 : i === 2 ? 1000 : 1 },
  }));
  const f = fixture(undefined, undefined, native);
  try {
    for (let n = 95; n <= 108; n++) await retain(f, "clock" + n, n);
    for (let n = 0; n < 5; n++) await retain(f, "anchored" + n, 0, 19);
    const { actual } = await collect(f);
    assertEquals(
      actual.filter((v) => v.startsWith("request:clock")).sort(),
      Array.from({ length: 14 }, (_, i) => "request:clock" + (i + 95)).sort(),
    );
    assertEquals(new Set(actual).size, actual.length);
  } finally {
    await f.value.stop();
  }
});
Deno.test("V2 pending request identity cannot be consumed by an equal native message ID", async () => {
  const f = fixture(
    undefined,
    undefined,
    newest.map((r) => ({
      ...r,
      time: { created: (Number(r.id.slice(4)) - 9) * 100 },
    })),
  );
  try {
    await retain(f, "anchored", 1, 10);
    await retain(f, "msg_19", 125);
    const { actual } = await collect(f);
    assertEquals(actual.filter((v) => v === "request:msg_19"), [
      "request:msg_19",
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
