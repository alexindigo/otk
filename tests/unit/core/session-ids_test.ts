// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  finishesMigrations,
  OtkDb,
  permissionMigrations,
  prefsMigrations,
  seenMigrations,
  sessionReferenceMigrations,
  tasksMigrations,
} from "@otk/store";
import { opencodeV1SessionID } from "@otk/harness-opencode-v1";
import { createSessionReferenceUpgrade } from "../../../core/features/session-ids.ts";

const migrations = [
  tasksMigrations,
  seenMigrations,
  finishesMigrations,
  permissionMigrations,
  prefsMigrations,
  sessionReferenceMigrations,
];
function seed(db: OtkDb) {
  db.connection.exec(`
    INSERT INTO tasks VALUES ('task','/project','Keep task',0);
    INSERT INTO task_sessions VALUES ('task','ses_one',3),('task','opcv1-ses_one',7),('task','ses_other',9);
    INSERT INTO session_seen(user,session,time) VALUES ('alice','ses_one',4),('alice','opcv1-ses_one',8),('bob','ses_one',6);
    INSERT INTO session_finishes(session,time) VALUES ('ses_one',5),('opcv1-ses_one',3);
    INSERT INTO permission_auto VALUES ('ses_one'),('opcv1-ses_one');
    INSERT INTO permission_activity VALUES (42,'ses_one','per_1','{"sessionID":"ses_one","patterns":["ses_one"],"extra":true}','once','auto','ses_other','keep message',17,'confirmed',NULL);
    INSERT INTO permission_activity VALUES (43,'ses_one','per_2','{invalid','reject','manual',NULL,NULL,18,'failed','keep error');
    INSERT INTO permission_activity_family VALUES ('ses_one',42),('opcv1-ses_one',42),('ses_other',42);
    INSERT INTO prefs VALUES ('shellLayout','{"projectLocations":[{"sidecarId":"remote","directory":"/project","sessionID":"ses_one","extra":3}],"extra":{"keep":true}}',123);
    INSERT INTO prefs VALUES ('other','{"sessionID":"ses_one"}',456);
  `);
}
const dump = (db: OtkDb) =>
  [
    "task_sessions",
    "session_seen",
    "session_finishes",
    "permission_auto",
    "permission_activity",
    "permission_activity_family",
    "prefs",
    "session_reference_upgrades",
  ].map((name) =>
    db.connection.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()
  );

Deno.test("independent proven upgrades preserve references and join metadata contributors atomically", () => {
  const root = Deno.makeTempDirSync();
  const db = new OtkDb(root, migrations, { busyms: 5000 });
  try {
    seed(db);
    createSessionReferenceUpgrade(opencodeV1SessionID.legacy)(db);
    const before = dump(db);
    const proven = (value: string) =>
      value === "opcv1-ses_one" ? "opcv2-ses_one" : value;
    const failure = createSessionReferenceUpgrade(proven, {
      name: "opencode-v2-proven-session-ids",
      collisions: "reject",
      references: () => {
        throw new Error("metadata contributor failed");
      },
    });
    assertThrows(() => failure(db), Error, "metadata contributor");
    assertEquals(dump(db), before);
    let contributions = 0;
    const upgrade = createSessionReferenceUpgrade(proven, {
      name: "opencode-v2-proven-session-ids",
      collisions: "reject",
      references: (_store, convert) => {
        assertEquals(
          convert("opcv1-ses_one", "metadata-receipt"),
          "opcv2-ses_one",
        );
        assertEquals(
          convert("opcv1-ses_other", "unproven-receipt"),
          "opcv1-ses_other",
        );
        contributions++;
      },
    });
    upgrade(db);
    upgrade(db);
    assertEquals(contributions, 1);
    assertEquals(
      db.connection.prepare(
        "SELECT session FROM task_sessions ORDER BY position",
      ).all(),
      [{ session: "opcv2-ses_one" }, { session: "opcv1-ses_other" }],
    );
  } finally {
    db.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("beta.1 references migrate atomically, merge only permitted collisions and preserve JSON", () => {
  const root = Deno.makeTempDirSync();
  const diagnostics: string[] = [];
  const upgrade = createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {
    diagnose: (field) => diagnostics.push(field),
    now: () => 100,
  });
  let db = new OtkDb(root, migrations, { busyms: 5000 });
  try {
    seed(db);
    upgrade(db);
    assertEquals(
      db.connection.prepare("SELECT * FROM task_sessions ORDER BY position")
        .all(),
      [
        { task: "task", session: "opcv1-ses_one", position: 3 },
        { task: "task", session: "opcv1-ses_other", position: 9 },
      ],
    );
    assertEquals(
      db.connection.prepare("SELECT * FROM session_seen ORDER BY user").all(),
      [{ user: "alice", session: "opcv1-ses_one", time: 8, terminal: 0 }, {
        user: "bob",
        session: "opcv1-ses_one",
        time: 6,
        terminal: 0,
      }],
    );
    assertEquals(
      db.connection.prepare("SELECT * FROM session_finishes").all(),
      [{ session: "opcv1-ses_one", time: 5, terminal: 0 }],
    );
    assertEquals(db.connection.prepare("SELECT * FROM permission_auto").all(), [
      { session: "opcv1-ses_one" },
    ]);
    const journal = db.connection.prepare(
      "SELECT * FROM permission_activity ORDER BY id",
    ).all();
    assertEquals(
      journal.map((
        r,
      ) => [r.id, r.session, r.owner, r.time, r.message, r.outcome]),
      [[
        42,
        "opcv1-ses_one",
        "opcv1-ses_other",
        17,
        "keep message",
        "confirmed",
      ], [43, "opcv1-ses_one", null, 18, null, "failed"]],
    );
    assertEquals(JSON.parse(String(journal[0].request)), {
      sessionID: "opcv1-ses_one",
      patterns: ["ses_one"],
      extra: true,
    });
    assertEquals(journal[1].request, "{invalid");
    assertEquals(diagnostics, ["permission_activity.request[43]"]);
    assertEquals(
      db.connection.prepare(
        "SELECT * FROM permission_activity_family ORDER BY session",
      ).all(),
      [{ session: "opcv1-ses_one", activity: 42 }, {
        session: "opcv1-ses_other",
        activity: 42,
      }],
    );
    const layout = db.connection.prepare(
      "SELECT * FROM prefs WHERE key='shellLayout'",
    ).get()!;
    assertEquals(JSON.parse(String(layout.value)), {
      projectLocations: [{
        sidecarId: "remote",
        directory: "/project",
        sessionID: "opcv1-ses_one",
        extra: 3,
      }],
      extra: { keep: true },
    });
    assertEquals(layout.updated, 123);
    assertEquals(
      db.connection.prepare("SELECT value FROM prefs WHERE key='other'").get()!
        .value,
      '{"sessionID":"ses_one"}',
    );
    const after = dump(db);
    upgrade(db);
    assertEquals(dump(db), after);
    db.close();
    db = new OtkDb(root, migrations, { busyms: 5000 });
    upgrade(db);
    assertEquals(dump(db), after);
  } finally {
    db.close();
    Deno.removeSync(root, { recursive: true });
  }
});

for (
  const failed of [
    "task_sessions",
    "session_seen",
    "session_finishes",
    "permission_auto",
    "permission_activity",
    "permission_activity_family",
    "prefs",
    "marker",
  ]
) {
  Deno.test(`ID upgrade rolls back after ${failed} and retries after reopen`, () => {
    const root = Deno.makeTempDirSync();
    let db = new OtkDb(root, migrations, { busyms: 5000 });
    try {
      seed(db);
      const before = dump(db);
      assertThrows(
        () =>
          createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {
            diagnose: () => {},
            checkpoint: (table) => {
              if (table === failed) throw new Error("injected failure");
            },
          })(db),
        Error,
        "injected failure",
      );
      assertEquals(dump(db), before);
      db.close();
      db = new OtkDb(root, migrations, { busyms: 5000 });
      createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {
        diagnose: () => {},
      })(db);
      assertEquals(
        db.connection.prepare(
          "SELECT count(*) AS n FROM session_reference_upgrades",
        ).get()!.n,
        1,
      );
    } finally {
      db.close();
      Deno.removeSync(root, { recursive: true });
    }
  });
}

Deno.test("conflicting task ownership aborts the entire ID upgrade", () => {
  const root = Deno.makeTempDirSync();
  const db = new OtkDb(root, migrations, { busyms: 5000 });
  try {
    seed(db);
    db.connection.exec(
      "INSERT INTO tasks VALUES ('other','/project','Other',1); UPDATE task_sessions SET task='other' WHERE session='opcv1-ses_one'",
    );
    const before = dump(db);
    assertThrows(
      () => createSessionReferenceUpgrade(opencodeV1SessionID.legacy)(db),
      Error,
      "Conflicting task membership",
    );
    assertEquals(dump(db), before);
  } finally {
    db.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("unknown references and malformed preferences survive with field-only diagnostics", () => {
  const root = Deno.makeTempDirSync();
  const db = new OtkDb(root, migrations, { busyms: 5000 });
  try {
    db.connection.exec(
      "INSERT INTO tasks VALUES ('task','/p','Task',0); INSERT INTO task_sessions VALUES ('task','unknown legacy reference',0); INSERT INTO prefs VALUES ('shellLayout','{invalid preference',12)",
    );
    const diagnostics: string[] = [];
    createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {
      diagnose: (field) => diagnostics.push(field),
    })(db);
    assertEquals(
      db.connection.prepare("SELECT session FROM task_sessions").get()!.session,
      "unknown legacy reference",
    );
    assertEquals(db.connection.prepare("SELECT * FROM prefs").get(), {
      key: "shellLayout",
      value: "{invalid preference",
      updated: 12,
    });
    assertEquals(diagnostics, ["task_sessions.session", "prefs.shellLayout"]);
  } finally {
    db.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("two independent startup contenders serialize the upgrade and publish one completion marker", async () => {
  const root = Deno.makeTempDirSync();
  let db = new OtkDb(root, migrations, { busyms: 5000 });
  seed(db);
  db.close();
  const owner =
    new URL("../../../core/features/session-ids.ts", import.meta.url).href;
  const code =
    `import { OtkDb } from "@otk/store"; import { opencodeV1SessionID } from "@otk/harness-opencode-v1"; import { createSessionReferenceUpgrade } from ${
      JSON.stringify(owner)
    }; const db = new OtkDb(${
      JSON.stringify(root)
    }, [], {busyms: 5000}); try { createSessionReferenceUpgrade(opencodeV1SessionID.legacy, {diagnose() {}})(db); } finally { db.close(); }`;
  try {
    const outcomes = await Promise.all(
      [0, 1].map(() =>
        new Deno.Command(Deno.execPath(), {
          args: ["eval", code],
          signal: AbortSignal.timeout(15000),
        }).output()
      ),
    );
    for (const outcome of outcomes) {
      assertEquals(outcome.code, 0, new TextDecoder().decode(outcome.stderr));
    }
    db = new OtkDb(root, migrations, { busyms: 5000 });
    assertEquals(
      db.connection.prepare(
        "SELECT count(*) AS n FROM session_reference_upgrades",
      ).get()!.n,
      1,
    );
    assertEquals(
      db.connection.prepare("SELECT count(*) AS n FROM task_sessions").get()!.n,
      2,
    );
  } finally {
    try {
      db.close();
    } catch { /* Closed parent before child startup. */ }
    Deno.removeSync(root, { recursive: true });
  }
});
