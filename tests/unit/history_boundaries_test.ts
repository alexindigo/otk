// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { History } from "../../sidecar/history/history.ts";
import { historyDraft } from "../../web/src/ui/prompt/history.ts";
import { fixture } from "../support/config.ts";
const captured = fromFileUrl(
  new URL("../fixtures/opencode1/history-1.18.34-v4.db", import.meta.url),
);
Deno.test("actual history shell lookup uses the native message session/time index", () => {
  const statements: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const reader = new History(captured);
  try {
    DatabaseSync.prototype.prepare = function (sql: string) {
      statements.push(sql);
      return prepare.call(this, sql);
    };
    assert(reader.list().some((row) => row.mode === "shell"));
  } finally {
    reader.close();
    DatabaseSync.prototype.prepare = prepare;
  }
  const sql = statements.find((sql) => sql.includes("JOIN part p"));
  assert(sql);
  const db = new DatabaseSync(captured, { readOnly: true });
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(
      "session",
      0,
      Number.MAX_SAFE_INTEGER,
      "message",
    ).map((row) => String(row.detail)).join("\n");
    console.info("History shell query plan:", plan);
    assert(
      /SEARCH a USING INDEX/.test(plan),
      "History shell lookup scans the message table",
    );
    assert(
      plan.includes("session_id=?") && plan.includes("time_created>?") &&
        plan.includes("time_created<?"),
      "History shell lookup is not session/time bounded",
    );
  } finally {
    db.close();
  }
});
async function database() {
  const path = join(await fixture(), "history.db");
  await Deno.copyFile(captured, path);
  const db = new DatabaseSync(path);
  const session = String(
    db.prepare("SELECT id FROM session LIMIT 1").get()!.id,
  );
  const time = Date.now();
  const message = (id: string, data: unknown, at = time) =>
    db.prepare(
      "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
    ).run(id, session, at, at, JSON.stringify(data));
  const part = (id: string, owner: string, data: unknown) =>
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run(id, owner, session, time, time, JSON.stringify(data));
  return { path, db, message, part, session, time };
}
Deno.test("history recall preserves stored relative mention labels without adding a duplicate basename chip", async () => {
  const f = await database();
  f.message("msg_label", { role: "user" });
  f.part("prt_label_text", "msg_label", {
    type: "text",
    text: "inspect @src/x.ts#3-4",
  });
  f.part("prt_label_file", "msg_label", {
    type: "file",
    filename: "src/x.ts#3-4",
    mime: "text/plain",
    url: "file:///project/src/x.ts?start=3&end=4",
    source: {
      type: "file",
      path: "src/x.ts",
      text: { value: "@src/x.ts#3-4", start: 8, end: 21 },
    },
  });
  f.db.close();
  const reader = new History(f.path);
  try {
    const entry = reader.list().find((row) =>
      row.input.startsWith("inspect @src")
    )!;
    const draft = historyDraft(entry);
    assertEquals(draft.input, "inspect @src/x.ts#3-4");
    assertEquals(draft.chips.length, 1);
    assertEquals(draft.chips[0].label, "@src/x.ts#3-4");
  } finally {
    reader.close();
  }
});
Deno.test("history list returns attachment metadata with no base64 or data URL bytes", () => {
  const reader = new History(captured);
  try {
    const entries = reader.list();
    assert(
      entries.some((row) => row.parts.some((part) => part.kind === "file")),
    );
    assertEquals(JSON.stringify(entries).includes("dataBase64"), false);
    assertEquals(JSON.stringify(entries).includes("data:image"), false);
    const attachment = entries.flatMap((row) => row.parts).find((part) =>
      part.kind === "file" && part.source === "history"
    );
    assert(attachment?.kind === "file" && attachment.source === "history");
    const fetched = reader.attachment(attachment.messageID, attachment.partID);
    assertEquals(fetched.mime, attachment.mime);
    assertEquals(fetched.name, attachment.name);
    assertEquals(atob(fetched.dataBase64).length, attachment.size);
    assert(fetched.dataBase64.length > 0);
  } finally {
    reader.close();
  }
});
for (const malformed of ["url", "json"] as const) {
  Deno.test(`history skips one malformed ${malformed} row and keeps valid history`, async () => {
    const f = await database();
    f.message("msg_malformed", { role: "user" });
    f.part("prt_bad", "msg_malformed", {
      type: "file",
      url: "not a valid url",
      mime: "text/plain",
    });
    if (malformed === "json") {
      f.db.prepare("UPDATE part SET data=? WHERE id=?").run("{bad", "prt_bad");
    }
    f.db.close();
    const reader = new History(f.path);
    const warn = console.warn, warnings: string[] = [];
    try {
      console.warn = (...values: unknown[]) => {
        warnings.push(values.join(" "));
        warn(...values);
      };
      assert(
        reader.list().some((row) => row.input === "history first"),
        "One malformed row erased every valid prompt",
      );
      assert(reader.list().some((row) => row.input === "history first"));
      assertEquals(
        warnings.filter((line) => line.includes("msg_malformed")).length,
        1,
      );
    } finally {
      reader.close();
      console.warn = warn;
    }
  });
}
