// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import {
  type DigestSnapshot,
  opencodeV1DigestMigrations,
  OpencodeV1DigestSink,
  type OpencodeV1DigestStorage,
} from "@otk/harness-opencode-v1";
import {
  opencodeV2DigestMigrations,
  OpencodeV2DigestSink,
} from "@otk/harness-opencode-v2-server";
import {
  DigestDb,
  digestMigrations,
  type DigestSessionRecord,
  DigestStore,
  type DigestUsageRecord,
} from "@otk/store";
import type { UsageSummary } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";
import {
  nativeHarness,
  selectedNative,
  startHarness,
} from "../support/native-testing.ts";
import { cfg } from "../support/config.ts";
import { tempDir, test } from "../support/resources.ts";

function summary(row: DigestUsageRecord): UsageSummary {
  return {
    calls: row.call_count ?? 0,
    cost: row.cost,
    tokens: {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cache_read, write: row.cache_write },
    },
    contextPeak: row.context_peak,
    ...(row.time_start === null ? {} : {
      time: {
        start: row.time_start,
        ...(row.time_end === null ? {} : { end: row.time_end }),
      },
    }),
  };
}
function scalars(
  value: UsageSummary | undefined,
  revision: number,
): DigestUsageRecord {
  return {
    revision,
    call_count: value?.calls ?? null,
    cost: value?.cost ?? null,
    input: value?.tokens.input ?? null,
    output: value?.tokens.output ?? null,
    reasoning: value?.tokens.reasoning ?? null,
    cache_read: value?.tokens.cache.read ?? null,
    cache_write: value?.tokens.cache.write ?? null,
    context_peak: value?.contextPeak ?? null,
    time_start: value?.time?.start ?? null,
    time_end: value?.time?.end ?? null,
  };
}
test("independent public-entry consumer composes native sink, scheduler and derived store without application modules", async () => {
  const fake = new FakeLlm(), oc = await selectedNative(fake);
  const session = await oc.createSession("Independent digest");
  fake.queue({ chunks: ["Independent reply"] });
  await oc.prompt(session.id, "Independent prompt");
  const harness = nativeHarness(oc);
  await startHarness(harness);
  const page = await waitFor(
    () => harness.core.listMessages(session.id, {}),
    (page) =>
      page.items.some((m) =>
        m.role === "assistant" && m.time.completed !== undefined
      ),
  );
  const expectedCalls = page.items.filter((m) => m.role === "assistant").length;
  const raw = await harness.core.getSession(session.id);
  const base = {
    id: raw.id,
    title: raw.title,
    directory: raw.directory,
    projectID: raw.projectID,
    timeCreated: raw.time.created,
    timeUpdated: raw.time.updated,
    archived: raw.archived,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  await harness.core.stop();
  const db = new DigestDb(await tempDir("public-digest-"), [
    digestMigrations,
    oc.kind === "opencode-v1"
      ? opencodeV1DigestMigrations
      : opencodeV2DigestMigrations,
  ], { busyms: 100 });
  const store = new DigestStore(db);
  const read = (id: string): DigestSnapshot | undefined => {
    const row = store.summary([id])[0];
    return row
      ? {
        metadata: base,
        summary: {
          state: row.state,
          revision: row.revision,
          ...(row.message_count === null
            ? {}
            : { messageCount: row.message_count }),
          ...(row.call_count === null ? {} : { total: summary(row) }),
        },
        deleted: row.deleted_at === null
          ? null
          : { at: row.deleted_at, how: row.deleted_how! },
      }
      : undefined;
  };
  const policy = {
    batch: 2,
    slicems: 8,
    cpu: 1,
    memoryreserve: 1,
    maxpending: 2,
    idlems: 1,
    parallel: 3,
    background: false,
    publishrows: 2,
    retryms: 10,
    busyms: 100,
  };
  const storage: OpencodeV1DigestStorage = {
    sql: db.connection,
    transaction: (run) => db.transaction(run),
    read,
    turn: (id, key) => {
      const row = store.turn(id, key);
      return row && summary(row);
    },
    known: function* () {
      const value = read(base.id);
      if (value) yield value;
    },
    diagnostic: (_id, error) => {
      throw error;
    },
    publish: () => {},
    write(metadata, delta, checkpoint) {
      const value = delta.summary, last = value.last;
      const row: DigestSessionRecord = {
        ...scalars(value.total, value.revision),
        id: metadata.id,
        provider: oc.kind,
        parent_id: metadata.parentID ?? null,
        directory: metadata.directory,
        project_id: metadata.projectID,
        title: metadata.title,
        time_created: metadata.timeCreated,
        time_updated: metadata.timeUpdated,
        archived: metadata.archived ? 1 : 0,
        message_count: value.messageCount ?? null,
        last_agent: last?.agent ?? null,
        last_provider: last?.model?.provider ?? null,
        last_model: last?.model?.model ?? null,
        context_input: last?.context?.input ?? null,
        context_output: last?.context?.output ?? null,
        context_reasoning: last?.context?.reasoning ?? null,
        context_cache_read: last?.context?.cache.read ?? null,
        context_cache_write: last?.context?.cache.write ?? null,
        state: value.state,
        digested_at: value.digestedAt ?? null,
        native_updated_at: value.nativeUpdatedAt ?? null,
        deleted_at: delta.deleted?.at ?? null,
        deleted_how: delta.deleted?.how ?? null,
      };
      store.commit({
        sessions: [row],
        turns: {
          upsert: Object.entries(delta.turns.upsert).map((
            [turn_id, total],
          ) => ({
            ...scalars(total, value.revision),
            session_id: metadata.id,
            turn_id,
            call_count: total.calls,
          })),
          remove: delta.turns.remove.map((turn_id) => ({
            session_id: metadata.id,
            turn_id,
          })),
        },
        bookkeeping: checkpoint
          ? [{
            session_id: metadata.id,
            last_message_id: checkpoint.lastMessage,
            last_message_hash: checkpoint.lastHash,
            generation: checkpoint.generation,
            dirty: checkpoint.dirty ? 1 : 0,
            digested_at: value.digestedAt ?? null,
            native_updated_at: metadata.timeUpdated,
          }]
          : [],
      });
    },
  };
  const settings = cfg();
  const sink = oc.kind === "opencode-v1"
    ? new OpencodeV1DigestSink(
      { ...settings, harness: { ...settings.harness, url: oc.url, db: oc.db } },
      policy,
      storage,
    )
    : new OpencodeV2DigestSink(
      {
        serviceFile: oc.serviceFile,
        db: oc.db,
        requestms: settings.harness.requestms,
        attachments: settings.attachments,
      },
      policy,
      storage,
    );
  const scheduler = new DigestScheduler(policy, {
    freeMemory: () => 1000,
    sleep: () => Promise.resolve(),
  });
  scheduler.register(sink);
  try {
    await sink.catalog(new AbortController().signal);
    scheduler.enqueue({
      provider: sink.identity,
      sessionID: session.id,
      updated: base.timeUpdated,
    }, "visible");
    while (await scheduler.tick()) { /* independent consumer owns its pump */ }
    assertEquals(read(session.id)?.summary.state, "ready");
    assertEquals(read(session.id)?.summary.total?.calls, expectedCalls);
    assertEquals(
      store.turns([session.id], "", 10).reduce(
        (count, row) => count + row.call_count,
        0,
      ),
      expectedCalls,
    );
  } finally {
    await scheduler.stop();
    db.close();
  }
});
