// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type {
  DigestDelta,
  HelperSummary,
  SessionMetadata,
} from "@otk/protocol";
import {
  OpencodeV2TranscriptDigestSink,
  type V2DigestStorage,
} from "../digest.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
import type { V2Client } from "../client.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 helper revalidation publishes only semantic changes, not scan generations", async () => {
  const db = new DatabaseSync(":memory:");
  for (const migration of opencodeV2DigestMigrations.migrations) {
    db.exec(await Deno.readTextFile(migration.sql));
  }
  let saved: ReturnType<V2DigestStorage["read"]>;
  const publications: DigestDelta[] = [];
  let available = true, count = 0, idle = 0, title = "Helper";
  let current: HelperSummary["current"];
  const client = {
    service: { pid: 1 },
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        session: {
          get: () =>
            Promise.resolve({
              id: "ses_helper",
              title,
              projectID: "p",
              location: { directory: "/repo" },
              time: { created: 1, updated: 2, idle },
            }),
        },
      }),
  } as unknown as V2Client;
  const sink = new OpencodeV2TranscriptDigestSink(
    cfg().digest,
    {
      sql: db,
      read: () => saved,
      turn: () => undefined,
      known: () => [],
      transaction: (run) => run(),
      write: (metadata: SessionMetadata, delta) => {
        saved = {
          metadata,
          summary: delta.summary,
          deleted: delta.deleted,
          helper: delta.helper ?? undefined,
        };
        publications.push(delta);
      },
      publish() {},
      diagnostic(_id, error) {
        throw error;
      },
    },
    {},
    {
      prepare: () => Promise.resolve({ client }),
      native: () => undefined,
      check: (signal) => signal.throwIfAborted(),
    },
  );
  sink.transcript.sqlHeaders = () => available ? [] : undefined;
  sink.transcript.helperAggregates = () =>
    available
      ? [{
        messageID: "msg_helper",
        toolCount: count,
        ...(current
          ? { current: { ...current, startedAt: current.startedAt ?? 1 } }
          : {}),
      }]
      : undefined;
  const scan = async () => {
    sink.invalidateHelper("opcv2-ses_helper");
    await sink.step(
      {
        sessionID: "opcv2-ses_helper",
        provider: sink.identity,
        updated: 2,
        revision: 0,
        projection: "helper",
      },
      { rows: 20, until: performance.now() + 1000 },
      new AbortController().signal,
    );
  };
  try {
    await scan();
    assertEquals(publications.length, 1);
    await scan();
    assertEquals(publications.length, 1);
    assertEquals(sink.requestHelper("opcv2-ses_helper", false), false);
    count = 1;
    await scan();
    assertEquals(saved?.helper?.revision, 2);
    current = { name: "read", title: "First", startedAt: 1 };
    await scan();
    current = { ...current, title: "Changed" };
    await scan();
    idle = 5;
    await scan();
    assertEquals(saved?.helper?.revision, 5);
    assertEquals(saved?.helper?.time?.end, 5);
    await scan();
    assertEquals(publications.length, 5);
    available = false;
    await scan();
    assertEquals(saved?.helper?.state, "unavailable");
    await scan();
    assertEquals(publications.length, 6);
    available = true;
    await scan();
    assertEquals(saved?.helper?.state, "ready");
    assertEquals(saved?.helper?.revision, 7);
    title = "Renamed";
    await scan();
    assertEquals(saved?.metadata.title, title);
    assertEquals(saved?.helper?.revision, 7);
    assertEquals(publications.length, 8);
    await scan();
    assertEquals(publications.length, 8);
  } finally {
    await sink.close();
    db.close();
  }
});
