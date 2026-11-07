// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { OpencodeV1Adapter } from "../adapter.ts";
import { StreamBuffers } from "@otk/content";
import { cfg } from "../../../tests/support/config.ts";
import { Transcript } from "../transcript.ts";
import { ContentReplay } from "@otk/harness";
import { Messages } from "../messages.ts";
import { Client } from "../client.ts";
import { mapSession } from "../map.ts";
import type { Session } from "../types.ts";
import type { PrefetchPage } from "../message-prefetch.ts";
import { waitFor } from "../../../tests/support/opencode.ts";

Deno.test("@load @messages standalone demanded miss joins canceled speculative I/O settlement", async () => {
  const settings = cfg();
  settings.digest.idlems = 1;
  settings.catalogs.concurrency = 1;
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    settle = Promise.withResolvers<void>();
  let reads = 0, active = 0, maximum = 0;
  const adapter = new OpencodeV1Adapter(
    settings,
    new StreamBuffers(),
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/session/s") {
        return Response.json({
          id: "s",
          directory: "/p",
          projectID: "p",
          title: "S",
          time: { created: 1, updated: 1 },
        });
      }
      if (!url.pathname.endsWith("/message")) return Response.json([]);
      const read = ++reads;
      maximum = Math.max(maximum, ++active);
      try {
        if (read === 2) {
          started.resolve();
          init!.signal!.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          await settle.promise;
          init!.signal!.throwIfAborted();
        }
        return Response.json([{
          info: {
            id: read === 1 ? "new" : "old",
            sessionID: "s",
            role: "user",
            time: { created: 1 },
          },
          parts: [],
        }], { headers: read === 1 ? { "x-next-cursor": "older" } : {} });
      } finally {
        active--;
      }
    },
  );
  try {
    const first = await adapter.core.listMessages("opcv1-s", {});
    await started.promise;
    const demanded = adapter.core.listMessages("opcv1-s", {
      before: first.older!,
    });
    await aborted.promise;
    assertEquals(
      reads,
      2,
      "essential demand cannot reuse the permission before actual settlement",
    );
    settle.resolve();
    assertEquals((await demanded).items[0].id, "old");
    assertEquals(reads, 3);
    assertEquals(maximum, 1);
  } finally {
    settle.resolve();
    await adapter.core.stop();
  }
});

Deno.test("@load @messages standalone successor prefetch waits for idle and serves a native-free hit", async () => {
  const f = fixture();
  f.settings.digest.idlems = 25;
  try {
    const first = await f.adapter.core.listMessages("opcv1-s", {});
    assertEquals(
      f.reads.filter((url) => url.pathname.endsWith("/message")).length,
      1,
      "proxy demand precedes idle speculation",
    );
    await waitFor(
      () => f.reads.filter((url) => url.pathname.endsWith("/message")).length,
      (n) => n === 2,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = f.reads.length;
    const next = await f.adapter.core.listMessages("opcv1-s", {
      before: first.older!,
    });
    assertEquals(next.items.length, 10);
    // Encoded volatile payloads omit absent optional properties, as the wire does.
    assertEquals(
      JSON.parse(JSON.stringify(next.prompt)),
      JSON.parse(JSON.stringify(first.prompt)),
    );
    assertEquals(next.older, null);
    assertEquals(f.reads.length, before);
  } finally {
    await f.adapter.core.stop();
  }
});

Deno.test("@load @messages prefetched bodies and scalar metadata reuse current replay clocks and mutations fence late completion", async () => {
  const settings = cfg();
  const replay = new ContentReplay({
    ...settings.messages,
    nonce: () => crypto.randomUUID(),
    emit() {},
  });
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  const row = (id: string) => ({
    info: { id, sessionID: "s", role: "user" as const, time: { created: 1 } },
    parts: [],
  });
  let bodies = 0, metadata = 0, speculative = 0;
  let held: ReturnType<typeof Promise.withResolvers<PrefetchPage>> | undefined;
  const reader = new Messages(
    new Client(
      settings.harness,
      () => Promise.reject(new Error("unexpected HTTP")),
    ),
    () => "/p",
  );
  reader.page = (_id, _limit, before) => {
    bodies++;
    return Promise.resolve(
      before ? { items: [row("old")] } : { items: [row("new")], next: "older" },
    );
  };
  const value: PrefetchPage = {
    page: { items: [row("cached")] },
    metadata: { boundaries: [], prompt: { id: "new" } },
  };
  const transcript = new Transcript({
    replay,
    reader,
    buffers: new StreamBuffers(),
    policy: settings.messages,
    raw: () => Promise.resolve(raw),
    info: (raw) => Promise.resolve(mapSession(raw)),
    decorate: (m) => m,
    summaries: () => ({}),
    metadata: () => {
      metadata++;
      return Promise.resolve({ boundaries: [], prompt: { id: "new" } });
    },
    prefetch: () => {
      speculative++;
      return held?.promise ?? Promise.resolve(value);
    },
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  try {
    const first = await transcript.page("opcv1-s");
    await flush();
    assertEquals(speculative, 1);
    replay.publish("opcv1-s", { op: "message.remove", messageID: "unrelated" });
    const current = replay.clock("opcv1-s");
    const hit = await transcript.page("opcv1-s", first.older!);
    assertEquals(hit.items.map((m) => m.id), ["cached"]);
    assertEquals([bodies, metadata], [1, 1]);
    assertEquals(hit.from, current);
    assertEquals(hit.clock, current);
    transcript.changed("opcv1-s");
    await transcript.page("opcv1-s", first.older!);
    assertEquals([bodies, metadata], [2, 2]);
    // A retired in-flight speculative result cannot repopulate the cache.
    held = Promise.withResolvers<PrefetchPage>();
    const newest = await transcript.page("opcv1-s");
    transcript.changed("opcv1-s");
    held.resolve(value);
    await flush();
    await transcript.page("opcv1-s", newest.older!);
    assertEquals([bodies, metadata], [4, 4]);
    held = undefined;
    await transcript.page("opcv1-s");
    await flush();
    transcript.observe({ ...raw, title: "Changed" });
    await transcript.page("opcv1-s", first.older!);
    assertEquals(
      bodies,
      6,
      "session metadata changes retire prefetched scalar authority",
    );
  } finally {
    transcript.release();
  }
});

Deno.test("@load @messages native page publishes atomic bodies before held metadata without another native read", async () => {
  const settings = cfg(), held = Promise.withResolvers<void>();
  let reads = 0;
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  const published = Promise.withResolvers<
    import("@otk/protocol").MessagePage
  >();
  const transcript = new Transcript({
    replay: new ContentReplay({
      ...settings.messages,
      nonce: () => "epoch",
      emit() {},
    }),
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => {
        reads++;
        return Promise.resolve(
          Response.json([{
            info: {
              id: "m",
              sessionID: "s",
              role: "user",
              time: { created: 1 },
            },
            parts: [],
          }]),
        );
      }),
      () => "/p",
    ),
    raw: () => Promise.resolve(raw),
    info: (value) => Promise.resolve(mapSession(value)),
    decorate: (message) => message,
    summaries: () => ({}),
    metadata: async () => {
      await held.promise;
      return { prompt: { id: "m" }, boundaries: [] };
    },
  });
  let settled = false;
  const result = transcript.page(
    "opcv1-s",
    undefined,
    undefined,
    published.resolve,
  )
    .then((page) => {
      settled = true;
      return page;
    });
  try {
    const page = await published.promise;
    assertEquals(page.items.map((item) => item.id), ["m"]);
    assertEquals(settled, false);
    assertEquals(reads, 1);
    held.resolve();
    assertEquals((await result).prompt?.id, "m");
    assertEquals(reads, 1);
  } finally {
    held.resolve();
    await result;
  }
});

function fixture() {
  const reads: URL[] = [];
  let cutoff: string | undefined;
  const native = "ZXhhY3QrcGFkZGluZw==";
  const settings = cfg();
  settings.harness.db = "/nonexistent-otk-message-pages.db";
  const fetcher: typeof fetch = (input) => {
    const url = new URL(String(input));
    reads.push(url);
    if (url.pathname === "/session/s") {
      return Promise.resolve(Response.json({
        id: "s",
        directory: "/project",
        projectID: "p",
        title: "Session",
        time: { created: 1, updated: 1 },
        ...(cutoff ? { revert: { messageID: cutoff } } : {}),
      }));
    }
    if (url.pathname === "/agent") return Promise.resolve(Response.json([]));
    if (url.pathname === "/session/s/message/m10") {
      if (url.searchParams.get("directory") !== "/project") {
        return Promise.resolve(new Response("wrong instance", { status: 404 }));
      }
      return Promise.resolve(
        Response.json({
          info: {
            id: "m10",
            sessionID: "s",
            role: "user",
            time: { created: 10 },
          },
          parts: [],
        }),
      );
    }
    if (url.pathname === "/session/s/message") {
      const older = url.searchParams.has("before");
      return Promise.resolve(Response.json(
        Array.from({ length: 10 }, (_, i) => ({
          info: {
            id: `m${String(i + (older ? 0 : 10)).padStart(2, "0")}`,
            sessionID: "s",
            role: "user",
            time: { created: i + (older ? 0 : 10) },
          },
          parts: [],
        })),
        { headers: older ? {} : { "x-next-cursor": native } },
      ));
    }
    throw new Error(`Unexpected native read ${url}`);
  };
  const adapter = new OpencodeV1Adapter(settings, new StreamBuffers(), fetcher);
  return {
    adapter,
    settings,
    reads,
    native,
    cutoff(value?: string) {
      cutoff = value;
    },
  };
}

Deno.test("transcript pages retain exact native continuation and reuse initial session metadata", async () => {
  const f = fixture();
  const page = await f.adapter.core.listMessages("opcv1-s", {});
  assertEquals(page.items.length, 10);
  assertEquals(page.session.id, "opcv1-s");
  assertEquals(page.clock.epoch, page.from.epoch);
  const firstReads =
    f.reads.filter((url) => url.pathname === "/session/s").length;
  const older = await f.adapter.core.listMessages("opcv1-s", {
    before: page.older!,
  });
  assertEquals(older.items.length, 10);
  assertEquals(older.prompt?.id, page.prompt?.id);
  assertEquals(
    older.older,
    null,
    "exact-multiple terminal pages use cursor, not length",
  );
  assertEquals(
    f.reads.filter((url) => url.pathname === "/session/s").length,
    firstReads,
  );
  assertEquals(
    f.reads.filter((url) => /\/message\//.test(url.pathname)).length,
    0,
  );
  const collections = f.reads.filter((url) =>
    url.pathname.endsWith("/message")
  );
  assertEquals(collections.map((url) => url.searchParams.get("limit")), [
    "10",
    "10",
  ]);
  assertEquals(collections[1].searchParams.get("before"), f.native);
  await f.adapter.core.stop();
});

Deno.test("transcript cursors reject malformed, foreign-session and retired-epoch tokens before I/O", async () => {
  const f = fixture();
  const page = await f.adapter.core.listMessages("opcv1-s", {});
  // Settle the independent initial directory read before counting invalid-cursor I/O.
  await f.adapter.capabilities.agents!.listAgents("opcv1-s");
  let count = f.reads.length;
  for (const before of ["m10", "x".repeat(4097)]) {
    await assertRejects(() =>
      f.adapter.core.listMessages("opcv1-s", { before })
    );
    assertEquals(f.reads.length, count);
  }
  await assertRejects(() =>
    f.adapter.core.listMessages("opcv1-other", { before: page.older! })
  );
  assertEquals(f.reads.length, count);
  f.adapter.core.subscriptions("opcv1-s", 0);
  count = f.reads.length;
  await assertRejects(() =>
    f.adapter.core.listMessages("opcv1-s", { before: page.older! })
  );
  assertEquals(f.reads.length, count);
  await f.adapter.core.stop();
});

Deno.test("rollback boundary resolution uses the authoritative page directory and returns only the visible history", async () => {
  const f = fixture();
  f.cutoff("m10");
  const page = await f.adapter.core.listMessages("opcv1-s", {});
  assertEquals(page.items.length, 10);
  assertEquals(page.items.every((message) => message.id < "m10"), true);
  assertEquals(page.prompt?.id, "m09");
  assertEquals(page.session.revert?.messageID, "m10");
  assertEquals(
    f.reads.filter((url) => url.pathname === "/session/s/message/m10").length,
    1,
  );
  await f.adapter.core.stop();
});

Deno.test("concurrent initial viewers share one raw session read and one caller cannot cancel another", async () => {
  const settings = cfg();
  const held = Promise.withResolvers<Session>();
  let rawReads = 0;
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  const transcript = new Transcript({
    replay: new ContentReplay({
      ...settings.messages,
      nonce: () => crypto.randomUUID(),
      emit() {},
    }),
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => Promise.resolve(Response.json([]))),
      () => "/p",
    ),
    raw: () => {
      rawReads++;
      return held.promise;
    },
    info: (value) => Promise.resolve(mapSession(value)),
    decorate: (message) => message,
    summaries: () => ({}),
  });
  const abort = new AbortController();
  const first = transcript.page("opcv1-s", undefined, abort.signal).catch((
    error,
  ) => error);
  const second = transcript.page("opcv1-s");
  abort.abort();
  held.resolve(raw);
  assertEquals((await first).name, "AbortError");
  assertEquals((await second).session.id, "opcv1-s");
  assertEquals(rawReads, 1);
});

Deno.test("a rollback observed while initial session metadata is held retires that page authority", async () => {
  const settings = cfg(), held = Promise.withResolvers<Session>();
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  const transcript = new Transcript({
    replay: new ContentReplay({
      ...settings.messages,
      nonce: () => crypto.randomUUID(),
      emit() {},
    }),
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => Promise.resolve(Response.json([]))),
      () => "/p",
    ),
    raw: () => held.promise,
    info: (value) => Promise.resolve(mapSession(value)),
    decorate: (message) => message,
    summaries: () => ({}),
  });
  const reading = transcript.page("opcv1-s");
  transcript.observe({ ...raw, revert: { messageID: "cutoff" } });
  held.resolve(raw);
  await assertRejects(() => reading);
});

Deno.test("ordinary observations during initial metadata acquisition preserve page authority and current metadata", async () => {
  const settings = cfg(), held = Promise.withResolvers<Session>();
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  const replay = new ContentReplay({
    ...settings.messages,
    nonce: () => crypto.randomUUID(),
    emit() {},
  });
  let reads = 0;
  const transcript = new Transcript({
    replay,
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => Promise.resolve(Response.json([]))),
      () => "/p",
    ),
    raw: () => {
      reads++;
      return held.promise;
    },
    info: (value) => Promise.resolve(mapSession(value)),
    decorate: (message) => message,
    summaries: () => ({}),
  });
  const reading = transcript.page("opcv1-s");
  transcript.observe({
    ...raw,
    title: "Renamed",
    time: { created: 1, updated: 2 },
  });
  held.resolve(raw);
  const page = await reading;
  assertEquals(page.session.title, "Renamed");
  assertEquals(page.clock.epoch, page.from.epoch);
  assertEquals(page.version, { generation: 0, revision: 0 });
  assertEquals(reads, 1);
});

Deno.test("cold session observations do not become a second native session index", async () => {
  const settings = cfg();
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  let rawReads = 0;
  const transcript = new Transcript({
    replay: new ContentReplay({
      ...settings.messages,
      nonce: () => crypto.randomUUID(),
      emit() {},
    }),
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => Promise.resolve(Response.json([]))),
      () => "/p",
    ),
    raw: () => {
      rawReads++;
      return Promise.resolve(raw);
    },
    info: (value) => Promise.resolve(mapSession(value)),
    decorate: (message) => message,
    summaries: () => ({}),
  });
  transcript.observe(raw);
  await transcript.page("opcv1-s");
  assertEquals(
    rawReads,
    1,
    "cold observations cannot seed cached content authority",
  );
});

Deno.test("an independent session lookup joins newer rollback authority instead of reinstalling stale metadata", async () => {
  const settings = cfg(), held = Promise.withResolvers<Session>();
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  let reads = 0;
  const transcript = new Transcript({
    replay: new ContentReplay({
      ...settings.messages,
      nonce: () => crypto.randomUUID(),
      emit() {},
    }),
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => Promise.resolve(Response.json([]))),
      () => "/p",
    ),
    raw: () => ++reads === 1 ? Promise.resolve(raw) : held.promise,
    info: (value) =>
      Promise.resolve({
        ...mapSession(value),
        revert: value.revert &&
          { messageID: value.revert.messageID, messageCount: 1, files: [] },
      }),
    decorate: (message) => message,
    summaries: () => ({}),
  });
  await transcript.page("opcv1-s");
  const reading = transcript.session("opcv1-s");
  transcript.observe({ ...raw, revert: { messageID: "cutoff" } });
  held.resolve(raw);
  assertEquals((await reading).revert?.messageID, "cutoff");
});

Deno.test("native transcript authority versions change for rollback/restore and producer resets, never ordinary metadata or demand release", async () => {
  const settings = cfg();
  const replay = new ContentReplay({
    ...settings.messages,
    nonce: () => crypto.randomUUID(),
    emit() {},
  });
  const raw: Session = {
    id: "s",
    directory: "/p",
    projectID: "p",
    title: "S",
    time: { created: 1, updated: 1 },
  };
  const invalidations: unknown[] = [];
  const transcript = new Transcript({
    replay,
    buffers: new StreamBuffers(),
    reader: new Messages(
      new Client(settings.harness, () => Promise.resolve(Response.json([]))),
      () => "/p",
    ),
    raw: () => Promise.resolve(raw),
    info: (value) => Promise.resolve(mapSession(value)),
    decorate: (message) => message,
    summaries: () => ({}),
    invalidated: (value) => invalidations.push(value),
  });
  const first = await transcript.page("opcv1-s");
  transcript.observe({
    ...raw,
    title: "Renamed",
    time: { created: 1, updated: 2 },
  });
  assertEquals(invalidations, []);
  assertEquals(replay.version("opcv1-s"), first.version);
  const reverted = { ...raw, revert: { messageID: "cutoff" } };
  transcript.observe(reverted);
  transcript.observe(reverted);
  assertEquals(invalidations, [{
    sessionID: "opcv1-s",
    version: { generation: 0, revision: 1 },
  }]);
  assertEquals(replay.version("opcv1-other"), first.version);
  transcript.observe(raw);
  assertEquals(invalidations.at(-1), {
    sessionID: "opcv1-s",
    version: { generation: 0, revision: 2 },
  });
  transcript.release("opcv1-s");
  assertEquals(invalidations.length, 2);
  assertEquals(replay.version("opcv1-s"), { generation: 0, revision: 2 });
  transcript.invalidate();
  assertEquals(invalidations.at(-1), {
    version: { generation: 1, revision: 0 },
  });
  assertEquals(replay.version("opcv1-other"), { generation: 1, revision: 0 });
});
