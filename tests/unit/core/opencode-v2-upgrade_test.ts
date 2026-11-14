// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  finishesMigrations,
  OtkDb,
  permissionMigrations,
  prefsMigrations,
  requestsMigrations,
  seenMigrations,
  sessionReferenceMigrations,
  tasksMigrations,
} from "@otk/store";
import type { DigestPort } from "@otk/harness";
import { createOpencodeV2Upgrade } from "../../../core/features/opencode-v2-upgrade.ts";
import { opencodeV1SessionID } from "@otk/harness-opencode-v1";
import { opencodeV2SessionID } from "@otk/harness-opencode-v2-server";
const codec = {
  source(value: string) {
    try {
      return opencodeV1SessionID.decode(value);
    } catch {
      return undefined;
    }
  },
  target: opencodeV2SessionID.encode,
};
const migrations = [
  tasksMigrations,
  seenMigrations,
  finishesMigrations,
  permissionMigrations,
  prefsMigrations,
  sessionReferenceMigrations,
  requestsMigrations,
];
function fixture() {
  const root = Deno.makeTempDirSync({ prefix: "v2-upgrade-" }),
    store = new OtkDb(root, migrations, { busyms: 0 }),
    db = store.connection;
  db.exec(
    `INSERT INTO tasks VALUES('task','/repo','Keep order',7); INSERT INTO task_sessions VALUES('task','opcv1-ses_one',3),('task','opcv1-ses_unproven',9); INSERT INTO session_seen(user,session,time) VALUES('alice','opcv1-ses_one',12),('bob','opcv1-ses_one',14); INSERT INTO session_finishes(session,time) VALUES('opcv1-ses_one',15); INSERT INTO permission_auto VALUES('opcv1-ses_one'); INSERT INTO permission_activity VALUES(1,'opcv1-ses_one','per_one','{"sessionID":"opcv1-ses_one","patterns":["opcv1-ses_one"]}','once','auto','opcv1-ses_one',NULL,11,'confirmed',NULL); INSERT INTO permission_activity_family VALUES('opcv1-ses_one',1); INSERT INTO prefs VALUES('shellLayout','{"projectLocations":[{"sidecarId":"foreign","directory":"/repo","sessionID":"opcv1-ses_one"},{"sidecarId":"local","directory":"/repo","sessionID":"opcv1-ses_one"}]}',19)`,
  );
  const receipts: [string, unknown][] = [
    ["session-created", {
      id: "opcv1-ses_one",
      parentID: "opcv1-ses_one",
      title: "opcv1-ses_one",
    }],
    ["session-renamed", { id: "opcv1-ses_one" }],
    ["session-rename-intent", { sessionID: "opcv1-ses_one", title: "Keep" }],
    ["session-boundary", {
      sessionID: "opcv1-ses_one",
      messageID: "opcv1-ses_one",
    }],
    ["session-boundary-intent", {
      sessionID: "opcv1-ses_one",
      messageID: null,
    }],
    ["project-session", { sessionID: "opcv1-ses_one", directory: "/repo" }],
    ["task", { id: "task", sessions: ["opcv1-ses_one", "opcv1-ses_unproven"] }],
    ["tasks", [{ id: "task", sessions: ["opcv1-ses_one"] }]],
    ["approval-policy", { enabled: ["opcv1-ses_one"], revision: 42 }],
    ["preferences", {
      shellLayout: {
        projectLocations: [{
          sidecarId: "foreign",
          directory: "/repo",
          sessionID: "opcv1-ses_one",
        }],
      },
    }],
    ["foreign-kind", { sessionID: "opcv1-ses_one" }],
  ];
  const insert = db.prepare(
    "INSERT INTO request_receipts(principal,client_id,intent_key,window_id,method,fingerprint,execution,state,seq,accepted_at,updated_at,retention_until,dispatched_at,scope_session,scope_resource,receipt_kind,receipt_json) VALUES('alice','client',?,'window','method','keep-fingerprint','native','reconciling',1,2,3,4,5,'opcv1-ses_one','opcv1-ses_one',?,?)",
  );
  receipts.forEach(([kind, value], i) =>
    insert.run(String(i), kind, JSON.stringify(value))
  );
  return {
    store,
    db,
    close() {
      store.close();
      Deno.removeSync(root, { recursive: true });
    },
  };
}
function reader(
  read: () => Promise<string[]>,
): DigestPort {
  return {
    start: () => Promise.resolve(),
    read: () => read(),
  } as unknown as DigestPort;
}
Deno.test("V2 proven reference upgrade awaits proof, preserves all allowlisted receipts and foreign locations", async () => {
  const f = fixture(),
    proof = Promise.withResolvers<string[]>();
  try {
    let calls = 0;
    const run = createOpencodeV2Upgrade(
      reader(() => {
        calls++;
        return proof.promise;
      }),
      codec,
    );
    const pending = run(f.store);
    await Promise.resolve();
    assertEquals(
      f.db.prepare("SELECT session FROM task_sessions ORDER BY position")
        .all()[0].session,
      "opcv1-ses_one",
    );
    const before = f.db.prepare(
      "SELECT * FROM request_receipts ORDER BY intent_key",
    ).all();
    proof.resolve(["ses_one"]);
    await pending;
    assertEquals(
      f.db.prepare(
        "SELECT session,position FROM task_sessions ORDER BY position",
      ).all(),
      [{ session: "opcv2-ses_one", position: 3 }, {
        session: "opcv1-ses_unproven",
        position: 9,
      }],
    );
    assertEquals(
      f.db.prepare("SELECT user,session,time FROM session_seen ORDER BY user")
        .all(),
      [{ user: "alice", session: "opcv2-ses_one", time: 12 }, {
        user: "bob",
        session: "opcv2-ses_one",
        time: 14,
      }],
    );
    assertEquals(
      f.db.prepare("SELECT session FROM permission_auto").get()!.session,
      "opcv2-ses_one",
    );
    assertEquals(
      f.db.prepare("SELECT session FROM permission_activity_family").get()!
        .session,
      "opcv2-ses_one",
    );
    const rows = f.db.prepare(
      "SELECT * FROM request_receipts ORDER BY intent_key",
    ).all();
    for (let i = 0; i < rows.length; i++) {
      const { scope_session: _s, receipt_json: _r, ...stable } = rows[i],
        { scope_session: _bs, receipt_json: _br, ...expected } = before[i];
      assertEquals(stable, expected);
      assertEquals(rows[i].scope_session, "opcv2-ses_one");
    }
    const values = new Map(
      rows.map(
        (row) => [row.receipt_kind, JSON.parse(String(row.receipt_json))],
      ),
    );
    assertEquals(values.get("session-created"), {
      id: "opcv2-ses_one",
      parentID: "opcv2-ses_one",
      title: "opcv1-ses_one",
    });
    assertEquals(values.get("session-boundary").messageID, "opcv1-ses_one");
    assertEquals(values.get("task").sessions, [
      "opcv2-ses_one",
      "opcv1-ses_unproven",
    ]);
    assertEquals(values.get("tasks")[0].sessions, ["opcv2-ses_one"]);
    assertEquals(values.get("approval-policy"), {
      enabled: ["opcv2-ses_one"],
      revision: 42,
    });
    assertEquals(values.get("foreign-kind"), { sessionID: "opcv1-ses_one" });
    assertEquals(
      values.get("preferences").shellLayout.projectLocations[0].sessionID,
      "opcv1-ses_one",
    );
    assertEquals(
      JSON.parse(
        String(
          f.db.prepare("SELECT value FROM prefs WHERE key='shellLayout'").get()!
            .value,
        ),
      ).projectLocations[0].sessionID,
      "opcv1-ses_one",
    );
    assertEquals(
      JSON.parse(
        String(
          f.db.prepare("SELECT value FROM prefs WHERE key='shellLayout'").get()!
            .value,
        ),
      ).projectLocations[1].sessionID,
      "opcv2-ses_one",
    );
    await run(f.store);
    assertEquals(calls, 1);
  } finally {
    f.close();
  }
});
Deno.test("V2 reference collision rolls back every owner and the marker", async () => {
  const f = fixture();
  try {
    f.db.exec(
      "INSERT INTO session_seen(user,session,time) VALUES('alice','opcv2-ses_one',99)",
    );
    const before = f.db.prepare("SELECT * FROM task_sessions ORDER BY position")
      .all();
    await assertRejects(
      () =>
        createOpencodeV2Upgrade(
          reader(() => Promise.resolve(["ses_one"])),
          codec,
        )(f.store),
      Error,
      "collision",
    );
    assertEquals(
      f.db.prepare("SELECT * FROM task_sessions ORDER BY position").all(),
      before,
    );
    assertEquals(
      f.db.prepare("SELECT * FROM session_reference_upgrades").all(),
      [],
    );
    assertEquals(
      f.db.prepare("SELECT scope_session FROM request_receipts LIMIT 1").get()!
        .scope_session,
      "opcv1-ses_one",
    );
  } finally {
    f.close();
  }
});
