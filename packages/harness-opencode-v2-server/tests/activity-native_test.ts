// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertGreater } from "@std/assert";
import { discoverV2 } from "@otk/harness-opencode-v2-server";
import { V2Client } from "../client.ts";
import { V2NativeDb } from "../native-db.ts";
import { V2SessionLists } from "../session-lists.ts";
import { readSessionActivity } from "../recency.ts";
import { metadata } from "../metadata.ts";
import { FakeLlm } from "../../../tests/support/fake-llm.ts";
import { nativeKind } from "../../../tests/support/native.ts";
import { OpencodeV2Test } from "../../../tests/support/opencode-v2.ts";
import { resources, withResources } from "../../../tests/support/resources.ts";
import { waitFor } from "../../../tests/support/opencode.ts";

Deno.test({
  name:
    "V2 activity ordering ignores rename archive and permission metadata but follows a new message in API and SQL",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 activity recency", async () => {
      const fake = new FakeLlm(), native = await OpencodeV2Test.start(fake);
      const old = await native.createSession("Old activity"),
        recent = await native.createSession("Recent activity");
      const owner = new AbortController();
      resources().defer("recency client", async () => {
        owner.abort();
        await client.join();
      });
      const client = new V2Client(
        await discoverV2(native.serviceFile),
        10_000,
        owner.signal,
      );
      const db = new V2NativeDb(native.db);
      resources().defer("recency DB", () => db.close());
      const read = async () => {
        const rows = [];
        for (const source of [undefined, db]) {
          const lists = new V2SessionLists();
          const page = await lists.read(
            { directory: native.directory, limit: 1 },
            client,
            source,
            owner.signal,
          );
          const next = await lists.read(
            { directory: native.directory, limit: 1, before: page.older! },
            client,
            source,
            owner.signal,
          );
          rows.push(
            [...page.items, ...next.items].map((
              row,
            ) => [row.id, row.timeUpdated]),
          );
        }
        assertEquals(rows[0], rows[1]);
        return rows[0];
      };
      const initial = await read();
      assertEquals(initial.map(([id]) => id), [recent.id, old.id]);
      for (
        const mutation of [
          { title: "Renamed without activity" },
          { archived: true },
          { archived: false },
          {
            permissions: [{
              action: "shell",
              resource: "*",
              effect: "ask" as const,
            }],
          },
        ]
      ) {
        await native.api.session.update({
          sessionID: old.nativeID,
          ...mutation,
        });
        assertEquals(await read(), initial);
        assertEquals(
          metadata(await readSessionActivity(client, old.nativeID)).timeUpdated,
          initial[1][1],
        );
        assertEquals(db.lookup([old.id])[0].timeUpdated, initial[1][1]);
      }
      fake.queue({ chunks: ["New activity reply."] });
      await native.prompt(old.id, "New activity prompt");
      await waitFor(
        async () =>
          (await native.api.session.get({ sessionID: old.nativeID })).time.idle,
        Boolean,
      );
      const final = await read();
      assertEquals(final.map(([id]) => id), [old.id, recent.id]);
      assertGreater(Number(final[0][1]), Number(initial[0][1]));
      assertEquals(
        metadata(await readSessionActivity(client, old.nativeID)).timeUpdated,
        final[0][1],
      );
    }),
});
