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
      native.exec(
        "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
      );
      const insert = native.prepare("INSERT INTO message VALUES(?,?,?,?)");
      for (
        const [id, terminal] of [["seed", 10], ["seed", 20], ["other", 99]]
      ) {
        insert.run(
          `${id}-${terminal}`,
          id,
          terminal,
          JSON.stringify({
            role: "assistant",
            finish: "stop",
            time: { completed: terminal },
          }),
        );
      }
      insert.run(
        "empty-user",
        "empty",
        30,
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

test("scale viewed-history fixture follows the latest valid V1 assistant terminal", async () => {
  const root = await fixture(),
    path = join(root, "native.db"),
    native = new DatabaseSync(path);
  native.exec(
    "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
  );
  const insert = native.prepare("INSERT INTO message VALUES(?,?,?,?)");
  const sessions = [
    "error",
    "error-completed",
    "tool-calls",
    "unknown",
    "unfinished",
    "same-clock",
  ];
  for (const id of sessions) {
    insert.run(
      "old",
      id,
      10,
      JSON.stringify({
        role: "assistant",
        finish: "stop",
        time: { completed: 20 },
      }),
    );
  }
  const latest = [
    ["error", { error: { name: "APIError" } }],
    ["error-completed", {
      error: { name: "APIError" },
      time: { completed: 31 },
    }],
    ["tool-calls", { finish: "tool-calls", time: { completed: 40 } }],
    ["unknown", { finish: "unknown", time: { completed: 40 } }],
    ["unfinished", { time: { completed: 40 } }],
    ["same-clock", { finish: "stop", time: { completed: 40 } }],
  ] as const;
  for (const [id, fields] of latest) {
    insert.run(
      "new-a",
      id,
      30,
      JSON.stringify({ role: "assistant", ...fields }),
    );
  }
  insert.run(
    "new-b",
    "same-clock",
    30,
    JSON.stringify({ role: "assistant", error: { name: "APIError" } }),
  );
  insert.run(
    "new-user",
    "error",
    50,
    JSON.stringify({ role: "user", time: { completed: 99 } }),
  );
  native.close();
  const store = new OtkDb(join(root, "state"), [seenMigrations], {
    busyms: 5000,
  });
  try {
    seedScaleSeen(
      store,
      path,
      "opencode-v1",
      sessions.map((id) => ({ id, nativeID: id })),
    );
    const tokens = new Map(
      new Seen(store).tokens().map((row) => [
        row.session,
        row.time,
      ]),
    );
    assertEquals(
      tokens,
      new Map([
        ["error", 30],
        ["error-completed", 31],
        ["same-clock", 30],
      ]),
    );
    const changed = new DatabaseSync(path);
    changed.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
      "new-invalid",
      "error",
      60,
      "not JSON",
    );
    changed.close();
    seedScaleSeen(
      store,
      path,
      "opencode-v1",
      sessions.map((id) => ({ id, nativeID: id })),
    );
    assertEquals(
      new Map(
        new Seen(store).tokens().map((row) => [
          row.session,
          row.time,
        ]),
      ),
      tokens,
    );
  } finally {
    store.close();
  }
});
