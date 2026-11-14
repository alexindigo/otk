// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import { prepareAttachments } from "@otk/client";
import type {
  HistoryAttachment,
  HistoryEntry,
  PromptPart,
  RpcParams,
  ServerFrame,
} from "@otk/protocol";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { IndexStore } from "../../../core/index/store.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import {
  seedUserSession,
  selectedNative,
  type TestNative,
} from "../../support/native-testing.ts";
import { SidecarTest } from "../../support/sidecar.ts";
import { WsClient } from "../../support/ws-client.ts";
import { tempDir, test } from "../../support/resources.ts";
import { RemainingMeasurements } from "../../support/remaining-measurements.ts";

test("4615 tasks retain ordered memberships while seen and task changes publish only their keys", async () => {
  const root = await tempDir("remaining-inbox-");
  const report = new RemainingMeasurements(root, "task-and-inbox-scale");
  const db = new OtkDb(root, [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ], { busyms: 5000 });
  const stores = {
    projects: new Projects(db),
    tasks: new Tasks(db),
    seen: new Seen(db),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  db.transaction(() => {
    const task = db.connection.prepare("INSERT INTO tasks VALUES(?,?,?,?)");
    const member = db.connection.prepare(
      "INSERT INTO task_sessions VALUES(?,?,?)",
    );
    const seen = db.connection.prepare(
      "INSERT INTO session_seen(user,session,time,terminal) VALUES(?,?,0,?)",
    );
    const finish = db.connection.prepare(
      "INSERT INTO session_finishes(session,time,terminal) VALUES(?,0,?)",
    );
    for (let n = 0; n < 4615; n++) {
      task.run(
        `task-${n}`,
        n < 251 ? "/main" : `/project-${n}`,
        `Task ${n}`,
        n,
      );
      for (let m = 0; m < (n % 3); m++) {
        member.run(`task-${n}`, `opcv1-ses_${n}_${m}`, m);
      }
      seen.run("local", `opcv1-ses_${n}`, n);
      finish.run(`opcv1-ses_${n}`, n + 1);
    }
  });
  const inbox = new InboxFeature(
    stores,
    new IndexStore(),
    "local",
    () => Promise.resolve([]),
    undefined,
    100,
    128,
  );
  try {
    const baseline = await report.time("baseline", () => inbox.baseline());
    assertEquals(baseline.inbox.tasks.length, 4615);
    assertEquals(Object.keys(baseline.inbox.seen).length, 4615);
    assertEquals(baseline.inbox.seen["opcv1-ses_2"], 2);
    assertEquals(baseline.inbox.finishes["opcv1-ses_2"], 3);
    const original = db.connection.prepare.bind(db.connection),
      statements: string[] = [];
    db.connection.prepare = ((sql: string) => {
      statements.push(sql);
      return original(sql);
    }) as typeof db.connection.prepare;
    for (const count of [251, 4615]) {
      statements.length = 0;
      const rows = report.sync(
        `list-${count}`,
        () => stores.tasks.list(count === 251 ? "/main" : undefined),
      );
      assertEquals(rows.length, count);
      assertEquals(statements.length, 2);
      assertEquals(rows[0].sessions, []);
      assertEquals(rows[2].sessions, ["opcv1-ses_2_0", "opcv1-ses_2_1"]);
      statements.length = 0;
      assertEquals(stores.tasks.get("task-2"), rows[2]);
      assertEquals(statements.length, 2);
    }
    const frames: ServerFrame[] = [];
    const release = inbox.listen((frame) => frames.push(frame));
    statements.length = 0;
    // SV1 publishes exact displayed terminal acknowledgements, not legacy clocks.
    stores.seen.acknowledge("local", "opcv1-ses_2", 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(statements.filter((sql) => /^\s*SELECT/i.test(sql)), []);
    assertEquals(frames.map((frame) => frame.t), ["inbox.patch"]);
    const mark = frames[0];
    assert(mark.t === "inbox.patch");
    assertEquals(mark.ops.map((op) => op.op), ["seen"]);
    assertEquals(inbox.get().seen["opcv1-ses_2"], 3);
    frames.length = 0;
    stores.tasks.rename("task-2", "Only changed task");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(frames.length, 1);
    const edit = frames[0];
    assert(edit.t === "inbox.patch");
    assertEquals(edit.ops.length, 1);
    assert(edit.ops[0].op === "task.upsert");
    assertEquals(edit.ops[0].task.id, "task-2");
    assertEquals(
      inbox.get().tasks.find((task) => task.id === "task-2")?.name,
      "Only changed task",
    );
    release();
    await report.write({
      tasks: 4615,
      mainTasks: 251,
      marks: 4615,
      listStatements: 2,
      seenPatchOps: mark.ops.length,
      taskPatchOps: edit.ops.length,
    });
  } finally {
    inbox.close();
    db.close();
  }
});

test("ten real provider attachments across two isolated origins are batched, ordered and all-or-fail", async () => {
  const root = await tempDir("remaining-origins-");
  const report = new RemainingMeasurements(root, "attachment-origin-scale");
  const origins: {
    fake: FakeLlm;
    native: TestNative;
    server: SidecarTest;
    client: WsClient;
  }[] = [];
  const expected: string[] = [], parts: PromptPart[] = [];
  try {
    for (let origin = 0; origin < 2; origin++) {
      const fake = new FakeLlm(), native = await selectedNative(fake);
      const files = Array.from({ length: 5 }, (_, n) => {
        const bytes = btoa(
          `%PDF-1.4\norigin-${origin}-attachment-${n}\n%%EOF\n`,
        );
        expected.push(bytes);
        return {
          name: `origin-${origin}-${n}.pdf`,
          mime: "application/pdf",
          dataBase64: bytes,
        };
      });
      await seedUserSession(native, `Origin ${origin}`, [
        `Private origin ${origin} prompt`,
      ], files);
      const server = await SidecarTest.start(native),
        client = new WsClient(server.url);
      origins.push({ fake, native, server, client });
      client.lease({ directory: native.directory, crumbs: [], rows: [] });
      await client.connect();
      const history = await client.rpc<HistoryEntry[]>("history.list", {});
      const refs = history.flatMap((entry) => entry.parts).filter((part) =>
        part.kind === "file" && part.source === "history"
      );
      assertEquals(refs.length, 5);
      parts.push(
        ...refs.map((part) => ({ ...part, sidecarID: `origin-${origin}` })),
      );
    }
    const calls: { origin: string; count: number }[] = [];
    const read = (
      origin: string,
      refs: { messageID: string; partID: string }[],
    ) => {
      calls.push({ origin, count: refs.length });
      return origins[Number(origin.at(-1))].client.rpc<
        { items: HistoryAttachment[] }
      >("history.attachments", { refs }).then((value) => value.items);
    };
    const result = await report.time(
      "prepare",
      () =>
        prepareAttachments(parts, "current-is-not-the-origin", {
          concurrency: 2,
          maxrefs: 64,
          maxbytes: 33554432,
        }, read),
    );
    assertEquals(calls, [{ origin: "origin-0", count: 5 }, {
      origin: "origin-1",
      count: 5,
    }]);
    assertEquals(
      result.map((part) =>
        part.kind === "file" && part.source === "upload" ? part.dataBase64 : ""
      ),
      expected,
    );
    const before = structuredClone(parts);
    const wrong = parts.map((part, index) =>
      index === 9 ? { ...part, partID: "missing" } : part
    ) as PromptPart[];
    await assertRejects(() =>
      prepareAttachments(wrong, "current-is-not-the-origin", {
        concurrency: 2,
        maxrefs: 64,
        maxbytes: 33554432,
      }, read)
    );
    assertEquals(
      parts,
      before,
      "A failed preparation cannot mutate the captured draft",
    );
    const target = await origins[0].native.createSession(
      "Combined original-origin bytes",
    );
    origins[0].fake.queue({ chunks: ["Combined origin attachments received"] });
    await origins[0].client.rpc(
      "session.prompt",
      {
        sessionID: target.id,
        mode: "normal",
        parts: result,
      } satisfies RpcParams<"session.prompt">,
    );
    const producer = origins[0].native;
    const submitted = producer.kind === "opencode-v2-server"
      ? (await producer.api.message.list({
        sessionID: target.nativeID,
        limit: 20,
        order: "desc",
      })).data
        .flatMap((row) =>
          row.type === "user"
            ? row.files?.map((file) =>
              `data:${file.mime};base64,${file.data}`
            ) ?? []
            : []
        )
      : (await producer.request<{ parts: { type: string; url?: string }[] }[]>(
        `/session/${target.id}/message`,
      ))
        .flatMap((row) => row.parts).filter((part) => part.type === "file").map(
          (part) => part.url,
        );
    assertEquals(
      submitted,
      expected.map((bytes) => `data:application/pdf;base64,${bytes}`),
    );
    for (const { native, server } of origins) {
      for (
        const name of ["otk.db", "otk.db-wal", "digest.db", "digest.db-wal"]
      ) {
        try {
          const bytes = new TextDecoder().decode(
            await Deno.readFile(join(native.root, `otk-${server.port}`, name)),
          );
          for (
            const value of [
              ...expected,
              "Private origin 0 prompt",
              "Private origin 1 prompt",
            ]
          ) assert(!bytes.includes(value), name);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    }
    await report.write({
      origins: 2,
      attachments: 10,
      initialBatches: calls.slice(0, 2),
      rejectedBatch: true,
      exactBytes: true,
      exactSubmittedBytes: true,
      contentAtRest: false,
    });
  } finally {
    for (const origin of origins.toReversed()) {
      await origin.client.close();
      await origin.server.stop();
      await origin.native.stop();
    }
  }
});
