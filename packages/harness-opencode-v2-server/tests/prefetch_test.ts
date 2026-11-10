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
    rows.map((r) => [r.id, { order: r.time.created }]),
  ),
  metadata: { prompt: { id: "msg_19" }, boundaries: [] },
});
function fixture(
  prefetch?: (signal: AbortSignal) => Promise<PrefetchPage>,
  cover?: () => Promise<TranscriptFacts["metadata"]>,
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
    session: { get: () => Promise.resolve(session) },
    message: {
      list: (input: { cursor?: string; order?: string }) => {
        bodies++;
        if (input.cursor) assertEquals(input.order, undefined);
        return Promise.resolve({
          data: [...(input.cursor ? older : newest)].reverse(),
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
        return Promise.resolve(facts(bodies === 1 ? newest : older));
      }
      speculative.push(options);
      return prefetch
        ? prefetch(options.signal)
        : Promise.resolve({ page: { items: older }, facts: facts(older) });
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
  return { value, counts: () => ({ bodies, scalars, coverage }), speculative };
}
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
