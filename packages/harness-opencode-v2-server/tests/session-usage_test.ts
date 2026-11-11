// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { DigestDelta } from "@otk/protocol";
import { OpencodeV2TranscriptDigestSink } from "../digest.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
import type { V2Client } from "../client.ts";
import { cfg } from "../../../tests/support/config.ts";

const zero = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
const unknown = {
  input: null,
  output: null,
  reasoning: null,
  cache: { read: null, write: null },
};
for (
  const example of [
    { name: "empty session", replies: [], known: false },
    { name: "all unknown replies", replies: [{}, {}], known: false },
    {
      name: "reported zero cost among unknown replies",
      replies: [{}, { cost: 0 }],
      known: true,
    },
    {
      name: "reported zero tokens among unknown replies",
      replies: [{}, { tokens: zero }],
      known: true,
    },
    {
      name: "native internal charges remain separate from reply usage",
      replies: [{ cost: 1, tokens: zero }],
      known: true,
      nativeCost: 9,
    },
  ]
) {
  Deno.test(`V2 session usage requires reported constituent usage: ${example.name}`, async () => {
    const db = new DatabaseSync(":memory:"), deltas: DigestDelta[] = [];
    for (const migration of opencodeV2DigestMigrations.migrations) {
      db.exec(await Deno.readTextFile(migration.sql));
    }
    const rows = example.replies.map((usage, index) => ({
      id: `msg_${index}`,
      type: "assistant",
      time: { created: 1, completed: 2 },
      model: { providerID: "fake", id: "scripted" },
      content: [],
      ...usage,
    }));
    const nativeCost = example.nativeCost ?? 0;
    const api = {
      session: {
        get: () =>
          Promise.resolve({
            id: "ses_usage",
            projectID: "p",
            location: { directory: "/repo" },
            time: { created: 1, updated: 2 },
            cost: nativeCost,
            tokens: zero,
          }),
      },
      message: { list: () => Promise.resolve({ data: rows, cursor: {} }) },
    };
    const client = {
      service: { pid: 1 },
      read: <T>(run: (value: unknown) => Promise<T>) => run(api),
    } as unknown as V2Client;
    const sink = new OpencodeV2TranscriptDigestSink(
      cfg().digest,
      {
        sql: db,
        read: () => undefined,
        turn: () => undefined,
        known: () => [],
        transaction: (run) => run(),
        write: (_metadata, delta) => {
          deltas.push(delta);
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
    try {
      await sink.step(
        {
          sessionID: "opcv2-ses_usage",
          provider: sink.identity,
          updated: 2,
          revision: 0,
        },
        { rows: 20, until: performance.now() + 1000 },
        new AbortController().signal,
      );
      const total = deltas.at(-1)?.summary.total;
      assert(total);
      assertEquals(total.cost, example.known ? nativeCost : null);
      assertEquals(total.tokens, example.known ? zero : unknown);
      if (example.name === "all unknown replies") {
        const detail = await sink.detail(
          "opcv2-ses_usage",
          "msg_0",
          new AbortController().signal,
        );
        assertEquals(detail.calls[0].cost, null);
        assertEquals(detail.calls[0].tokens, unknown);
      }
    } finally {
      await sink.close();
      db.close();
    }
  });
}
