// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb, pluginStorageMigrations, PluginStore } from "@otk/store";
import { tempDir, test } from "../../../tests/support/resources.ts";
import { V1RecordRetention } from "../record-retention.ts";
import { eventRecord } from "../records.ts";

test("V1 request observations preserve raw evidence and terminal authority across transports", () => {
  for (const kind of ["permission", "question"]) {
    const retained = new V1RecordRetention();
    const id = `${kind}:r`, sessionID = "opcv1-s";
    retained.observe(sessionID, id, { title: "inventory" }, 10);
    retained.observe(sessionID, id, { metadata: { native: "raw" } }, 20, true);
    retained.observe(sessionID, id, { title: "normalized again" }, 30);
    assertEquals(retained.get(sessionID, id)?.request, {
      metadata: { native: "raw" },
    });
    assertEquals(retained.get(sessionID, id)?.created, 10);
    const message = eventRecord("s", id, 10, `${kind}.replied`, {
      requestID: "r",
      reply: "reject",
    });
    retained.put({ id, sessionID, created: 10, message });
    const settled = retained.get(sessionID, id);
    retained.observe(sessionID, id, { title: "late inventory" }, 40);
    retained.observe(sessionID, id, { metadata: "late raw" }, 50, true);
    assertEquals(retained.get(sessionID, id), settled);
    assertEquals(retained.page(sessionID, undefined, 10), [message]);
  }
});

test("V1 retained request outcomes and retry actions survive a restart beside an incompatible plugin", async () => {
  const root = await tempDir("v1-record-retention-");
  let db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
  try {
    const storage = new PluginStore(db);
    const retained = new V1RecordRetention();
    retained.bind(storage.scope("opencode-v1"));
    const fake = storage.scope("fake-plugin");
    fake.set("records/schema", "different-schema");
    const sid = "opcv1-s";
    for (
      const [id, type, data] of [
        ["permission:per", "permission.replied", {
          requestID: "per",
          reply: "reject",
        }],
        ["question:que", "question.rejected", { requestID: "que" }],
        ["retry:one", "session.retry", {
          attempt: 1,
          message: "Rate limited",
          next: 20,
          action: {
            reason: "limit",
            provider: "test",
            title: "Quota",
            message: "Try later",
            label: "Account",
            link: "https://example.com/account",
          },
        }],
      ] as const
    ) {
      const message = eventRecord("s", id, 10, type, data);
      retained.put({
        id,
        sessionID: sid,
        created: 10,
        request: { original: "kept" },
        message,
      });
      fake.set(
        `records/identity/${encodeURIComponent(sid)}/${encodeURIComponent(id)}`,
        "incompatible JSON from another harness",
      );
    }
    db.close();
    db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
    const reopened = new V1RecordRetention();
    reopened.bind(new PluginStore(db).scope("opencode-v1"));
    assertEquals(reopened.get(sid, "permission:per")?.request, {
      original: "kept",
    });
    const rows = reopened.page(sid, undefined, 2);
    assertEquals(rows.map((row) => row.id), ["retry:one", "question:que"]);
    assertEquals(
      reopened.page(sid, { created: 10, id: rows[1].id }, 2).map((row) =>
        row.id
      ),
      ["permission:per"],
    );
    assertEquals(
      new PluginStore(db).scope("fake-plugin").get("records/schema"),
      "different-schema",
    );
    reopened.remove(sid);
    assertEquals(reopened.page(sid, undefined, 10), []);
    assertEquals(
      new PluginStore(db).scope("fake-plugin").get(
        `records/identity/${encodeURIComponent(sid)}/retry%3Aone`,
      ),
      "incompatible JSON from another harness",
    );
  } finally {
    db.close();
  }
});
