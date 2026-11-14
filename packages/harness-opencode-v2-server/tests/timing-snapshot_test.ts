// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { TurnTimingAccumulator } from "@otk/harness";
import { TranscriptReads } from "../transcript-reads.ts";
import { Messages } from "../messages.ts";

Deno.test("V2 timing reads a coherent native header and part snapshot during concurrent updates", async () => {
  const root = await Deno.makeTempDir({ prefix: "timing-snapshot-" });
  const file = root + "/native.db", writer = new DatabaseSync(file);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT)",
  );
  const message = {
    time: { created: 1000, streamed: 1500, completed: 2000 },
    model: { providerID: "p", id: "m" },
    content: [],
  };
  const part = {
    type: "tool",
    id: "t",
    name: "read",
    state: { status: "completed", input: { path: "/f" }, content: [] },
    time: { created: 1400, ran: 1400, completed: 1800 },
  };
  writer.prepare(
    "INSERT INTO session_message VALUES('m','s','assistant',1,1000,?)",
  ).run(JSON.stringify(message));
  writer.prepare("INSERT INTO session_part VALUES('m','s',0,'tool',?)").run(
    JSON.stringify(part),
  );
  const reader = new DatabaseSync(file, { readOnly: true });
  let changed = false;
  try {
    const native = {
      prepare(query: string) {
        const statement = reader.prepare(query);
        return new Proxy(statement, {
          get(target, key, receiver) {
            if (key === "all") {
              return (...args: Parameters<typeof statement.all>) => {
                const rows = statement.all(...args);
                if (!changed && /^\s*SELECT\b/i.test(query)) {
                  changed = true;
                  writer.prepare("UPDATE session_message SET data=?").run(
                    JSON.stringify({
                      ...message,
                      time: { created: 1000, streamed: 9000, completed: 10000 },
                    }),
                  );
                  writer.prepare("UPDATE session_part SET data=?").run(
                    JSON.stringify({
                      ...part,
                      time: { ...part.time, completed: 9900 },
                    }),
                  );
                }
                return rows;
              };
            }
            const value = Reflect.get(target, key, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const reads = new TranscriptReads(
      new Messages(() => {
        throw new Error("No HTTP");
      }),
      () => native,
    );
    const owner = new TurnTimingAccumulator();
    owner.add(reads.sqlHeaders("opcv2-s", undefined, 10)![0].timing!);
    const result = owner.result();
    assert(result?.state === "known");
    assertEquals(changed, true);
    assert(
      (result.end === 2000 && result.workingMs === 800) ||
        (result.end === 10000 && result.workingMs === 8900),
      "Header and part clocks came from different native snapshots",
    );
  } finally {
    reader.close();
    writer.close();
    await Deno.remove(root, { recursive: true });
  }
});
