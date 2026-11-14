// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
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
import { withResources } from "../support/resources.ts";

Deno.test({
  name:
    "OC2D1 active-project discovery is bounded, resumable and excluded from startup, through SQL and API sources",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 keyed discovery", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        settings = cfg();
      const targets = [];
      for (let i = 0; i < 3; i++) {
        targets.push(await native.createSession(`Active ${i}`));
      }
      const other = native.root + "/other";
      await Deno.mkdir(other);
      const unrelated = await native.api.session.create({
        location: { directory: other },
        title: "Unrelated",
      });
      for (const sql of [true, false]) {
        const db = new DatabaseSync(":memory:"),
          rows = new Map<
            string,
            NonNullable<ReturnType<V2DigestStorage["read"]>>
          >();
        for (const migration of opencodeV2DigestMigrations.migrations) {
          db.exec(await Deno.readTextFile(migration.sql));
        }
        let transactions = 0, pageWrites = 0, failWrite = false;
        const published: string[][] = [];
        const storage: V2DigestStorage = {
          sql: db,
          // One commit per bounded page; a failure rolls the whole page back.
          transaction: (run) => {
            transactions++;
            pageWrites = 0;
            const before = new Map(rows);
            try {
              return run();
            } catch (error) {
              rows.clear();
              for (const [id, row] of before) rows.set(id, row);
              throw error;
            }
          },
          read: (id) => rows.get(id),
          turn: () => undefined,
          known: () => rows.values(),
          write: (metadata, delta) => {
            if (failWrite && ++pageWrites > 1) {
              throw new Error("injected write");
            }
            rows.set(metadata.id, {
              metadata,
              summary: delta.summary,
              deleted: delta.deleted,
            });
          },
          publish() {
            throw new Error("Pages publish through the bounded set owner");
          },
          publishAll(values) {
            published.push(values.map((value) => value.sessionID));
            return Promise.resolve();
          },
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
        );
        try {
          sink.connection(1);
          assertEquals(
            (await sink.catalog(new AbortController().signal)).entries,
            [],
          );
          assertEquals(
            (await sink.discover(new AbortController().signal)).entries,
            [],
          );
          assertEquals(
            rows.size,
            0,
            "Startup cannot retain the idle session population",
          );
          sink.discoveryProject(native.directory, true);
          // A failed page commits and publishes nothing; the cursor does not
          // advance, so the retry returns exact results.
          failWrite = true;
          let failed = false;
          for (let step = 0; step < 10 && !failed; step++) {
            try {
              if (
                (await sink.discover(new AbortController().signal)).complete
              ) {
                break;
              }
            } catch (error) {
              assert(String(error).includes("injected write"));
              failed = true;
            }
          }
          assert(failed, "A two-row page must reach the injected failure");
          assertEquals([...rows.keys()].sort(), published.flat().sort());
          failWrite = false;
          for (let step = 0; step < 10; step++) {
            if ((await sink.discover(new AbortController().signal)).complete) {
              break;
            }
          }
          assertEquals(
            [...rows.keys()].sort(),
            targets.map((target) => target.id).sort(),
          );
          assertEquals(published.flat().sort(), [...rows.keys()].sort());
          rows.clear();
          published.length = 0;
          sink.discoveryProject(native.directory, false);
          sink.discoveryProject(native.directory, true);
          transactions = 0;
          const acquired: string[] = [];
          let pages = 0;
          for (let step = 0; step < 10; step++) {
            const page = await sink.discover(new AbortController().signal);
            pages++;
            assert(page.entries.length <= 2);
            assert(
              page.entries.every((entry) =>
                entry.directory === native.directory
              ),
            );
            acquired.push(...page.entries.map((entry) => entry.id));
            if (page.complete) break;
            assert(step < 9, "Discovery cursor must exhaust");
          }
          assertEquals(
            acquired.sort(),
            targets.map((target) => target.id).sort(),
          );
          // Fixed commit/publication cost is paid per page, not per identity.
          assertEquals(transactions, pages);
          assertEquals(published.flat().sort(), acquired);
          assert(published.length < acquired.length);
          assert(published.every((set) => set.length <= 2));
          sink.discoveryProject(native.directory, false);
          sink.discoveryProject(other, true);
          const selected: string[] = [];
          for (let step = 0; step < 10; step++) {
            const page = await sink.discover(new AbortController().signal);
            assert(page.entries.every((entry) => entry.directory === other));
            selected.push(...page.entries.map((entry) => entry.id));
            if (page.complete) break;
            assert(step < 9);
          }
          assertEquals(selected, [`opcv2-${unrelated.id}`]);
          const abort = new AbortController();
          abort.abort();
          await assertRejects(() => sink.discover(abort.signal), DOMException);
        } finally {
          await sink.close();
          db.close();
        }
      }
    }),
});
