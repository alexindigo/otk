// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { OtkDb, Seen, seenMigrations } from "@otk/store";
import { fixture } from "../support/config.ts";
import { test } from "../support/resources.ts";
import { seedScaleSeen } from "../support/scale-seen.ts";

function v1Schema(native: DatabaseSync, sessions: readonly string[]) {
  native.exec(`CREATE TABLE session(id TEXT, parent_id TEXT, directory TEXT,
    project_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER,
    time_archived INTEGER);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  const insert = native.prepare(
    "INSERT INTO session VALUES(?,NULL,'/fixture','project',?,1,100,NULL)",
  );
  for (const id of sessions) insert.run(id, id);
}

function v2Schema(
  native: DatabaseSync,
  sessions: readonly {
    id: string;
    idle?: number;
    outcome?: string;
  }[],
) {
  native.exec(`CREATE TABLE project(id TEXT, worktree TEXT);
    INSERT INTO project VALUES('project','/fixture');
    CREATE TABLE session_v2(id TEXT, project_id TEXT, directory TEXT,
      parent_id TEXT, time_created INTEGER, time_updated INTEGER,
      time_idle INTEGER, idle_outcome TEXT);
    CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER,
      type TEXT, time_created INTEGER, data TEXT);`);
  const insert = native.prepare(
    "INSERT INTO session_v2 VALUES(?,'project','/fixture',NULL,1,100,?,?)",
  );
  for (const row of sessions) {
    insert.run(row.id, row.idle ?? null, row.outcome ?? null);
  }
}

function v2Shell(native: DatabaseSync, id: string, terminal: number) {
  native.prepare("INSERT INTO session_message VALUES(?,?,1,'shell',1,?)")
    .run(`shell-${id}`, id, JSON.stringify({ time: { completed: terminal } }));
}

for (const kind of ["opencode-v1", "opencode-v2-server"] as const) {
  test(`scale viewed-history fixture acknowledges exact ${kind} seed terminals only`, async () => {
    const root = await fixture(),
      path = join(root, "native.db"),
      native = new DatabaseSync(path);
    if (kind === "opencode-v1") {
      v1Schema(native, ["seed", "other", "empty"]);
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
      v2Schema(native, [
        { id: "seed", idle: 20, outcome: "succeeded" },
        { id: "other", idle: 99, outcome: "failed" },
        { id: "empty", idle: 30 },
      ]);
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

test("scale viewed-history fixture follows the native V1 terminal inventory", async () => {
  const root = await fixture(),
    path = join(root, "native.db"),
    native = new DatabaseSync(path);
  const sessions = [
    "error",
    "error-completed",
    "tool-calls",
    "unknown",
    "completion-only",
    "same-clock",
  ];
  v1Schema(native, sessions);
  const insert = native.prepare("INSERT INTO message VALUES(?,?,?,?)");
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
    ["completion-only", { time: { completed: 40 } }],
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
        ["tool-calls", 20],
        ["unknown", 20],
        ["completion-only", 40],
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

for (
  const [name, idle, outcome, shell, expected] of [
    ["shell-only", undefined, undefined, 30, 30],
    ["shell-newer", 20, "succeeded", 30, 30],
    ["idle-newer", 40, "failed", 30, 40],
    ["idle-interrupted", 40, "interrupted", 30, 40],
    ["invalid-idle", 50, "unknown", 30, 30],
    ["no-terminal", 50, undefined, undefined, undefined],
  ] as const
) {
  test(`scale viewed-history fixture follows native V2 ${name} terminal evidence`, async () => {
    const root = await fixture(),
      path = join(root, "native.db"),
      native = new DatabaseSync(path);
    v2Schema(native, [
      { id: "seed", idle, outcome },
      { id: "unmapped", idle: 99, outcome: "succeeded" },
    ]);
    if (shell !== undefined) v2Shell(native, "seed", shell);
    v2Shell(native, "unmapped", 120);
    native.close();
    const store = new OtkDb(join(root, "state"), [seenMigrations], {
      busyms: 5000,
    });
    try {
      seedScaleSeen(store, path, "opencode-v2-server", [{
        id: "mapped-seed",
        nativeID: "seed",
      }]);
      assertEquals(
        new Seen(store).tokens(),
        expected === undefined
          ? []
          : [{ user: "local", session: "mapped-seed", time: expected }],
      );
      assertEquals(new Seen(store).time("local", "mapped-seed"), 0);
    } finally {
      store.close();
    }
  });
}

test("scale viewed-history fixture traverses every native V2 terminal page with exact identities", async () => {
  const root = await fixture(),
    path = join(root, "native.db"),
    native = new DatabaseSync(path);
  const sessions = Array.from(
    { length: 205 },
    (_, i) => ({ id: `native-${String(i).padStart(3, "0")}` }),
  );
  v2Schema(native, sessions);
  for (const [i, row] of sessions.entries()) v2Shell(native, row.id, 1000 + i);
  native.close();
  const store = new OtkDb(join(root, "state"), [seenMigrations], {
    busyms: 5000,
  });
  try {
    seedScaleSeen(
      store,
      path,
      "opencode-v2-server",
      sessions.map((row) => ({ id: `mapped-${row.id}`, nativeID: row.id })),
    );
    const tokens = new Seen(store).tokens();
    assertEquals(tokens.length, sessions.length);
    const values = new Map(tokens.map((row) => [row.session, row.time]));
    for (const [i, row] of sessions.entries()) {
      assertEquals(values.get(`mapped-${row.id}`), 1000 + i);
    }
  } finally {
    store.close();
  }
});
