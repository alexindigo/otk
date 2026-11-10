// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  opencodeV2DigestMigrations,
  OpencodeV2DigestSink,
  type V2DigestStorage,
} from "@otk/harness-opencode-v2-server";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { nativeKind } from "../support/native.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, withResources } from "../support/resources.ts";

Deno.test({
  name:
    "OC2HS1 native helper summaries use scalar aggregates and retain counts across revalidation without tool-detail reads",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 scalar helper owner", async () => {
      const fake = new FakeLlm();
      fake.queue({ tool: { name: "read", input: { path: "note.txt" } } });
      fake.queue({ chunks: ["Read complete"] });
      const native = await OpencodeV2Test.start(fake, {
        prepare: (fixture) =>
          Deno.writeTextFile(
            fixture.directory + "/note.txt",
            "private tool body",
          ),
      });
      const target = await native.createSession();
      await native.prompt(target.id, "Read note.txt");
      await waitFor(
        () =>
          native.api.message.list({ sessionID: target.nativeID, limit: 20 }),
        (page) =>
          page.data.some((m) => m.type === "assistant" && !!m.time.completed),
      );
      await waitFor(
        () => native.api.session.active(),
        (active) => !active[target.nativeID],
      );
      const fetcher = globalThis.fetch;
      let bodyReads = 0;
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (/\/api\/session\/[^/]+\/message(?:\?|$)/.test(url)) bodyReads++;
        return fetcher(input, init);
      };
      // Each test module owns an isolated process and restores its transport.
      resources().defer(
        "restore helper fetch",
        () => {
          globalThis.fetch = fetcher;
        },
      );
      for (const sql of [true, false]) {
        const db = new DatabaseSync(":memory:"), settings = cfg();
        for (const migration of opencodeV2DigestMigrations.migrations) {
          db.exec(await Deno.readTextFile(migration.sql));
        }
        const saved = new Map<
            string,
            NonNullable<ReturnType<V2DigestStorage["read"]>>
          >(),
          reads: string[] = [];
        const storage: V2DigestStorage = {
          sql: db,
          transaction: (run) => run(),
          read: (id) => saved.get(id),
          turn: () => undefined,
          known: () => saved.values(),
          write: (metadata, delta) => {
            saved.set(metadata.id, {
              metadata,
              summary: delta.summary,
              deleted: delta.deleted,
              helper: delta.helper ?? saved.get(metadata.id)?.helper,
            });
          },
          publish() {},
          diagnostic() {},
        };
        const sink = new OpencodeV2DigestSink(
          {
            serviceFile: native.serviceFile,
            db: sql ? native.db : native.root + "/missing.db",
            requestms: settings.harness.requestms,
            attachments: settings.attachments,
          },
          { ...settings.digest, batch: 2 },
          storage,
          {},
          (operation) => reads.push(operation),
        );
        try {
          sink.connection(1);
          const signal = new AbortController().signal;
          await sink.hydrate([target.id], signal);
          if (sql) {
            // Existing installs may retain the old per-tool derived shape.
            // Source revalidation must replace it, not add it to aggregate rows.
            db.prepare(
              "INSERT INTO opcv2_transcript_helper VALUES (?,?,?,? ,?)",
            ).run(
              target.id,
              "msg_retained",
              "msg_retained:tool:old",
              JSON.stringify({
                tool: { name: "old" },
                status: "running",
                created: 1,
              }),
              9,
            );
          }
          for (let generation = 0; generation < 2; generation++) {
            if (generation) sink.invalidateHelper(target.id);
            const beforeBodies = bodyReads;
            for (let i = 0; i < 10; i++) {
              const next = await sink.step(
                {
                  sessionID: target.id,
                  provider: sink.identity,
                  updated: 0,
                  revision: generation,
                  projection: "helper",
                },
                { rows: 2, until: performance.now() + 100 },
                signal,
                {
                  priority: "background",
                  workms: 0,
                  wait: async (value) => await value,
                  join: async (value) => await value,
                  charge() {},
                },
              );
              if (!next) break;
            }
            assertEquals(
              bodyReads,
              beforeBodies,
              "Background helper acquisition must not read API bodies",
            );
            assertEquals(
              saved.get(target.id)?.helper?.state,
              sql ? "ready" : "unavailable",
            );
            assertEquals(
              saved.get(target.id)?.helper?.toolCount,
              sql ? 1 : null,
            );
          }
          assertEquals(reads.filter((operation) => operation === "tools"), []);
          assertEquals(reads.includes("helpers"), sql);
          assertEquals(
            db.prepare("SELECT count(*) AS n FROM opcv2_transcript_helper")
              .get()?.n,
            sql ? 1 : 0,
          );
        } finally {
          await sink.close();
          db.close();
        }
      }
    }),
});
