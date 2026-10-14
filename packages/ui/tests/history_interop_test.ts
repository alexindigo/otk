// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { History } from "@otk/harness-opencode1";
import { historyDraft, PromptHistory } from "../components/prompt/history.ts";
import {
  editDraft,
  emptyDraft,
  serialize,
} from "../components/prompt/model.ts";
import { fixture } from "../../../tests/support/config.ts";

const captured = fromFileUrl(
  new URL(
    "../../../tests/fixtures/opencode1/history-1.18.34-v4.db",
    import.meta.url,
  ),
);
Deno.test("prompt history consumer preserves captured attachments and refuses recall across changed drafts", async () => {
  const reader = new History(captured);
  try {
    const entries = await reader.listHistory();
    assertEquals(serialize(historyDraft(entries[2])), entries[2].parts);
    const cursor = new PromptHistory();
    cursor.replace(entries);
    const newest = cursor.move(-1, emptyDraft())!;
    assertEquals(newest.input, "history newest");
    assertEquals(
      cursor.move(-1, editDraft(newest, "changed draft")),
      undefined,
    );
    assertEquals(cursor.move(-1, newest)?.mode, "shell");
  } finally {
    reader.close();
  }
});
Deno.test("history recall preserves stored relative mention labels without adding a duplicate basename chip", async () => {
  const path = join(await fixture(), "history.db");
  await Deno.copyFile(captured, path);
  const db = new DatabaseSync(path);
  const session = String(
      db.prepare("SELECT id FROM session LIMIT 1").get()!.id,
    ),
    time = Date.now();
  db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
  )
    .run("msg_label", session, time, time, JSON.stringify({ role: "user" }));
  const part = (id: string, data: unknown) =>
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    )
      .run(id, "msg_label", session, time, time, JSON.stringify(data));
  part("prt_label_text", { type: "text", text: "inspect @src/x.ts#3-4" });
  part("prt_label_file", {
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
  db.close();
  const reader = new History(path);
  try {
    const entry = (await reader.listHistory()).find((row) =>
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
