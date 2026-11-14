// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { OtkDb, pluginStorageMigrations, PluginStore } from "@otk/store";
import { tempDir, test } from "../../../tests/support/resources.ts";
import {
  positionOrder,
  type RequestPosition,
  V2RequestRetention,
} from "../request-retention.ts";

test("V2 request schema survives SQLite reopen and identical hostile-plugin names remain isolated", async () => {
  const root = await tempDir("v2-request-retention-");
  let db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
  try {
    const storage = new PluginStore(db),
      own = storage.scope("opencode-v2-server"),
      other = storage.scope("fake-plugin"),
      retention = new V2RequestRetention();
    other.set("requests/schema", "incompatible fake schema");
    retention.bind(own);
    for (let index = 0; index < 35; index++) {
      const id = `request:${String(index).padStart(3, "0")}`;
      await retention.put({
        sessionID: "session/one",
        id,
        request: { title: `Question ${index}` },
        outcome: {
          id,
          sessionID: "session/one",
          role: "context",
          time: { created: index },
          parts: [],
        },
        position: { after: 100 - index, rank: 1, basis: "stream" },
      });
    }
    const entries = own.scan({ prefix: "requests/", limit: 100 });
    for (const entry of entries) {
      if (entry.key !== "requests/schema") {
        other.set(entry.key, "hostile value with exactly the same key");
      }
    }
    await retention.close();
    db.close();
    db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
    const reopened = new V2RequestRetention(),
      scopes = new PluginStore(db),
      scope = scopes.scope("opencode-v2-server");
    const limits: number[] = [];
    reopened.bind({
      ...scope,
      scan(input) {
        limits.push(input.limit);
        return scope.scan(input);
      },
    });
    const ids: string[] = [];
    let edge: { created: number; id: string } | undefined;
    for (;;) {
      const page = await reopened.page("session/one", edge, 10);
      if (!page.length) break;
      ids.push(...page.map((row) => row.id));
      const last = page.at(-1)!;
      edge = { created: last.time.created, id: last.id };
    }
    assertEquals(
      ids,
      Array.from(
        { length: 35 },
        (_, i) => `request:${String(34 - i).padStart(3, "0")}`,
      ),
    );
    assertEquals(limits.every((limit) => limit === 10), true);
    const ordered = await reopened.page(
      "session/one",
      undefined,
      10,
      "sequence",
    );
    assertEquals(
      ordered.map((row) => row.id),
      Array.from(
        { length: 10 },
        (_, i) => `request:${String(i).padStart(3, "0")}`,
      ),
    );
    assertEquals(
      (await reopened.page(
        "session/one",
        {
          created: ordered[9].time.created,
          id: ordered[9].id,
          order: ordered[9].sourceOrder,
        },
        10,
        "sequence",
      ))[0].id,
      "request:010",
    );
    assertEquals(
      (await reopened.get("session/one", "request:000"))?.request?.title,
      "Question 0",
    );
    assertEquals(
      scopes.scope("fake-plugin").get("requests/schema"),
      "incompatible fake schema",
    );
    await reopened.remove("session/one");
    assertEquals(await reopened.page("session/one", undefined, 10), []);
    assertEquals(
      scopes.scope("fake-plugin").get(entries[0].key),
      "hostile value with exactly the same key",
    );
    const invalid = new V2RequestRetention();
    assertThrows(
      () => invalid.bind(scopes.scope("fake-plugin")),
      Error,
      "Unsupported V2 request schema",
    );
  } finally {
    db.close();
  }
});
test("V2 observation positions rank within a native sequence gap, bound pages, keep clock fallbacks and retire at a revert boundary", async () => {
  const retention = new V2RequestRetention(), sid = "session/two";
  const put = (id: string, created: number, position: RequestPosition) =>
    retention.put({
      sessionID: sid,
      id,
      outcome: {
        id: `request:${id}`,
        sessionID: sid,
        role: "context",
        time: { created },
        parts: [],
      },
      position,
    });
  // Three settlements with no native message between them share sequence 7.
  for (const [index, id] of ["a", "b", "c"].entries()) {
    assertEquals(retention.rank(sid, 7), index + 1);
    await put(id, 900 - index, { after: 7, rank: index + 1, basis: "stream" });
  }
  await put("d", 5, { after: 3, rank: 1, basis: "lookup" });
  await put("e", 50, { after: null, rank: 0, basis: "clock" });
  await put("f", 60, { after: null, rank: 0, basis: "pending" });
  const orders = (await retention.page(sid, undefined, 10, "sequence")).map(
    (m) => [m.id, m.sourceOrder],
  );
  assertEquals(orders, [
    ["request:c", 7 + 3 / 4],
    ["request:b", 7 + 2 / 3],
    ["request:a", 7.5],
    ["request:d", 3.5],
  ]);
  // Strictly between native 7 and 8, never equal to a native sequence.
  assertEquals(
    positionOrder({ after: 7, rank: 1, basis: "stream" })! > 7 &&
      positionOrder({ after: 7, rank: 99, basis: "stream" })! < 8,
    true,
  );
  const ids = async (order: number) =>
    (await retention.page(sid, { created: 0, id: "", order }, 10, "sequence"))
      .map((m) => m.id);
  assertEquals(await ids(8), [
    "request:c",
    "request:b",
    "request:a",
    "request:d",
  ]);
  assertEquals(await ids(7), ["request:d"]);
  assertEquals(await ids(7 + 2 / 3), ["request:a", "request:d"]);
  assertEquals(await ids(1), []);
  // No sequence evidence: clock placement only, and nothing is lost.
  assertEquals(
    (await retention.page(sid, undefined, 10, "unanchored")).map((m) => m.id),
    ["request:f", "request:e"],
  );
  assertEquals((await retention.page(sid, undefined, 10)).length, 6);
  // Moving a provisional position re-indexes it without duplicates.
  await put("d", 5, { after: 4, rank: 1, basis: "stream" });
  assertEquals(await ids(5), ["request:d"]);
  assertEquals(retention.cutoff(sid, 6), 6);
  assertEquals(await retention.retire(sid, retention.cutoff(sid)!), 3);
  assertEquals(await retention.get(sid, "a"), undefined);
  assertEquals(
    (await retention.page(sid, undefined, 10, "sequence")).map((m) => m.id),
    ["request:d"],
  );
  assertEquals(retention.cutoff(sid, null), undefined);
  await retention.remove(sid);
  assertEquals(await retention.page(sid, undefined, 10), []);
});
