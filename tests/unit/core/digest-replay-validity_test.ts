// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import { createIndex, sessionSummary, summaryMeter } from "@otk/client";
import {
  decodeDerived,
  knownDerived,
  type SessionMetadata,
} from "@otk/protocol";
import { DigestDb, digestMigrations, DigestStore } from "@otk/store";
import { opencodeV1DigestMigrations } from "@otk/harness-opencode-v1";
import {
  helper,
  snapshot,
  usage as storedUsage,
  write,
} from "../../../core/digest/storage.ts";
import type { FromWorker, ToWorker } from "../../../core/digest/protocol.ts";
import { cfg } from "../../support/config.ts";
import { tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

const metadata: SessionMetadata = {
  id: "opcv1-ses_retained",
  directory: "/p",
  projectID: "p",
  title: "Retained",
  timeCreated: 1,
  timeUpdated: 2,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
};
const tokens = {
  input: 20,
  output: 3,
  reasoning: 2,
  cache: { read: 4, write: 1 },
};
const usage = knownDerived(
  {
    calls: 1,
    cost: 0,
    tokens,
    contextPeak: 25,
    timing: {
      state: "unknown" as const,
      start: 1000,
      terminal: true,
      reason: "migration" as const,
    },
  },
  "native/call",
  7,
  true,
);
const context = knownDerived(
  { callID: "call", model: { provider: "p", model: "m" }, context: tokens },
  "native/call",
  7,
  true,
);

test("pre-contract cache migration retains knowledge without inventing finality or call identity", async () => {
  const root = await tempDir("digest-result-upgrade-");
  const old = new DigestDb(root, [{
    ...digestMigrations,
    migrations: digestMigrations.migrations.slice(0, 2),
  }], { busyms: 100 });
  old.connection.exec(`
    INSERT INTO digest_sessions(id,provider,directory,project_id,title,time_created,time_updated,archived,state,revision,call_count,cost,last_agent,context_input)
    VALUES('opcv1-ses_retained','opencode-v1','/p','p','Retained',1,2,0,'digesting',7,1,0,'build',20);
    INSERT INTO digest_sessions(id,provider,directory,project_id,title,time_created,time_updated,archived,state)
    VALUES('opcv1-ses_empty','opencode-v1','/p','p','Empty',1,2,0,'digesting');
    INSERT INTO digest_turns(session_id,turn_id,call_count,cost,revision) VALUES('opcv1-ses_retained','turn',1,0,7);
    INSERT INTO digest_helpers(session_id,state,revision,tool_count) VALUES('opcv1-ses_retained','digesting',7,2);
  `);
  old.close();
  const db = new DigestDb(root, [digestMigrations], { busyms: 100 });
  try {
    const store = new DigestStore(db);
    const saved = snapshot(store.summary([metadata.id])[0]);
    assert(saved.summary.total?.state === "known");
    assertEquals(saved.summary.total.value.cost, 0);
    assertEquals(saved.summary.total.final, false);
    assert(saved.summary.last?.state === "known");
    assertEquals(saved.summary.last.value.callID, null);
    assertEquals(saved.summary.last.value.context?.input, 20);
    assertEquals(storedUsage(store.turn(metadata.id, "turn")!).state, "known");
    assertEquals(
      helper(store.helpers([metadata.id])[0]).progress.state,
      "known",
    );
    assertEquals(
      snapshot(store.summary(["opcv1-ses_empty"])[0]).summary.total,
      { state: "pending" },
    );
  } finally {
    db.close();
  }
});

test("derived codecs retain witnesses, finality, null reporting and explicit no-value states", () => {
  for (
    const result of [usage, { state: "pending" }, { state: "unavailable" }]
  ) {
    assertEquals(
      decodeDerived(JSON.parse(JSON.stringify(result)), (value) => value),
      result,
    );
  }
  const unknown = knownDerived(
    { ...usage.state === "known" ? usage.value : {}, cost: null },
    "native/call",
    8,
  );
  assertEquals(
    decodeDerived(JSON.parse(JSON.stringify(unknown)), (value) => value),
    unknown,
  );
  for (
    const invalid of [
      { state: "pending", value: 0 },
      {
        state: "known",
        value: 0,
        final: true,
        witness: { source: "", revision: 0 },
      },
      {
        state: "known",
        value: 0,
        final: true,
        witness: { source: "native", revision: -1 },
      },
    ]
  ) assertThrows(() => decodeDerived(invalid, (value) => value), TypeError);
});

test("multipart cached replay under held credit and worker restart preserve each known unit", async () => {
  const root = await tempDir("digest-result-replay-");
  const db = new DigestDb(
    root,
    [digestMigrations, opencodeV1DigestMigrations],
    { busyms: 100 },
  );
  const store = new DigestStore(db);
  write(store, "opencode-v1", metadata, {
    summary: { state: "ready", revision: 9, total: usage, last: context },
    helper: {
      state: "ready",
      revision: 4,
      progress: knownDerived(
        { toolCount: 2, current: { name: "read" }, time: { start: 1, end: 2 } },
        "native/helper",
        4,
        true,
      ),
    },
    turns: {
      upsert: {
        a: usage,
        b: usage,
        c: usage,
        retired: usage,
        pending: { state: "pending" },
      },
      remove: [],
    },
    deleted: null,
  });
  write(store, "opencode-v1", metadata, {
    summary: { state: "ready", revision: 10, total: usage, last: context },
    turns: { upsert: {}, remove: ["retired"] },
    deleted: null,
  });
  db.close();
  const server = new SessionIndex(), client = createIndex();
  server.upsertMetadata(metadata);
  assertEquals(sessionSummary(server.get(metadata.id)), undefined);
  assertEquals(summaryMeter(server.get(metadata.id)), {});
  let revision = 0;
  for (const restart of [false, true]) {
    const worker = new Worker(
      new URL("../../../core/digest/worker.ts", import.meta.url).href,
      { type: "module" },
    );
    const frames: FromWorker[] = [], run = crypto.randomUUID();
    const send = (message: ToWorker) => worker.postMessage(message);
    const receive = (data: FromWorker) => {
      frames.push(data);
      if (data.t === "catalog") {
        for (const entry of data.entries) server.upsertMetadata(entry);
        client.receive("one", {
          t: "index.snapshot",
          rev: ++revision,
          entries: server.snapshotEntries().map((entry) =>
            structuredClone(entry)
          ),
        });
      }
      if (data.t === "digest") {
        server.applyDigest({
          id: data.sessionID,
          revision: data.revision,
          ...data.delta,
        });
        client.receive("one", {
          t: "index.patch",
          rev: ++revision,
          ops: [{
            op: "digest",
            id: data.sessionID,
            revision: data.revision,
            ...data.delta,
          }],
        });
      }
    };
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (data.t === "digests") {
        for (const value of data.values) {
          receive({ ...value, t: "digest", run: data.run, id: 0 });
        }
      } else receive(data);
    };
    try {
      send({
        t: "start",
        run,
        id: 1,
        provider: "opencode-v1",
        statePath: root,
        since: 0,
        native: {
          harness: {
            url: "http://127.0.0.1:1",
            username: "",
            password: "",
            db: root + "/absent.db",
            heartbeattimeout: 25,
            reconnectmax: 30,
            requestms: 60000,
          },
          index: { days: 30 },
          attachments: cfg().attachments,
        },
        policy: {
          batch: 2,
          slicems: 8,
          cpu: 1,
          memoryreserve: 1,
          maxpending: 128,
          idlems: 1,
          parallel: 3,
          background: false,
          publishrows: 1,
          retryms: 10,
          busyms: 100,
        },
      });
      await waitFor(
        () => frames.some((frame) => frame.t === "accepted"),
        Boolean,
      );
      send({ t: "credit", run, id: 2, publications: 2 });
      send({
        t: "hydrate",
        run,
        id: 3,
        sessions: [metadata.id],
        retained: true,
      });
      await waitFor(
        () => frames.some((frame) => frame.t === "digest"),
        Boolean,
      );
      const first = frames.find((frame) => frame.t === "digest");
      assert(first?.t === "digest");
      assertEquals(first.last, false);
      assertEquals(
        first.delta.summary.state,
        "ready",
        "Transport completion is not value validity",
      );
      assertEquals(first.delta.summary.total, usage);
      assertEquals(first.delta.summary.last, context);
      for (
        const entry of [server.get(metadata.id), client.get("one", metadata.id)]
      ) {
        assertEquals(sessionSummary(entry)?.cost, 0);
        assertEquals(summaryMeter(entry).tokens, 30);
        assertEquals(entry?.digest.helper?.progress.state, "known");
      }
      // Credit waits yield the executing slot and native permission stays free.
      send({ t: "native.acquire", run, id: 4 });
      await waitFor(
        () =>
          frames.some((frame) =>
            frame.t === "native.granted" && frame.id === 4
          ),
        Boolean,
      );
      send({ t: "native.release", run, id: 5, request: 4 });
      if (restart) {
        send({ t: "credit", run, id: 6, publications: 20 });
        await waitFor(
          () => frames.some((frame) => frame.t === "digest" && frame.last),
          Boolean,
        );
        const entry = server.get(metadata.id)!;
        assertEquals(entry.digest.turns.a, usage);
        assertEquals(entry.digest.turns.pending, { state: "pending" });
        assertEquals(entry.digest.turns.retired, undefined);
        assertEquals(
          client.get("one", metadata.id)?.digest.turns,
          entry.digest.turns,
        );
      }
    } finally {
      send({ t: "stop", run, id: 7 });
      await waitFor(
        () => frames.some((frame) => frame.t === "stopped"),
        Boolean,
      );
      worker.terminate();
    }
  }
});
