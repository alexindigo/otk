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
        const storage: V2DigestStorage = {
          sql: db,
          transaction: (run) => run(),
          read: (id) => rows.get(id),
          turn: () => undefined,
          known: () => rows.values(),
          write: (metadata, delta) => {
            rows.set(metadata.id, {
              metadata,
              summary: delta.summary,
              deleted: delta.deleted,
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
          const acquired: string[] = [];
          for (let step = 0; step < 10; step++) {
            const page = await sink.discover(new AbortController().signal);
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
