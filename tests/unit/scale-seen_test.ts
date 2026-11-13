// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { OtkDb, Seen, seenMigrations } from "@otk/store";
import { fixture } from "../support/config.ts";
import { test } from "../support/resources.ts";
import { seedScaleSeen } from "../support/scale-seen.ts";

for (const kind of ["opencode-v1", "opencode-v2-server"] as const) {
  test(`scale viewed-history fixture acknowledges exact ${kind} seed terminals only`, async () => {
    const root = await fixture(),
      path = join(root, "native.db"),
      native = new DatabaseSync(path);
    if (kind === "opencode-v1") {
      native.exec("CREATE TABLE message(session_id TEXT, data TEXT)");
      const insert = native.prepare("INSERT INTO message VALUES(?,?)");
      for (
        const [id, terminal] of [["seed", 10], ["seed", 20], ["other", 99]]
      ) {
        insert.run(
          id,
          JSON.stringify({
            role: "assistant",
            time: { completed: terminal },
          }),
        );
      }
      insert.run(
        "empty",
        JSON.stringify({ role: "user", time: { created: 30 } }),
      );
    } else {
      native.exec(
        `CREATE TABLE session_v2(id TEXT, time_idle INTEGER, idle_outcome TEXT);
        INSERT INTO session_v2 VALUES('seed',20,'succeeded'),('other',99,'failed'),
          ('empty',30,NULL);`,
      );
    }
    native.close();
    const store = new OtkDb(join(root, "state"), [seenMigrations], {
      busyms: 5000,
    });
    try {
      seedScaleSeen(store, path, kind, [
        { id: "seeded", nativeID: "seed" },
        { id: "empty", nativeID: "empty" },
      ]);
      const seen = new Seen(store);
      assertEquals(seen.tokens(), [{
        user: "local",
        session: "seeded",
        time: 20,
      }]);
      assertEquals(seen.time("local", "seeded"), 0);
      assertEquals(seen.tokens().some((row) => row.session === "other"), false);
      // A new terminal cannot be covered by this exact historical watermark.
      assertEquals(21 > seen.tokens()[0].time, true);
    } finally {
      store.close();
    }
  });
}
