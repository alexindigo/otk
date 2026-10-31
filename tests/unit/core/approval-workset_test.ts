// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import { IndexStore } from "../../../core/index/store.ts";
import type { IndexEntry, PermissionRequest } from "@otk/protocol";
import { fixture } from "../../support/config.ts";
import { test } from "../../support/resources.ts";

const tick = () => new Promise((done) => setTimeout(done, 0));
test("auto-approve unrelated title and digest updates perform zero scans or policy SQL", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]);
  const store = new PermissionStore(db), index = new IndexStore();
  let lists = 0, policies = 0, enumerations = 0;
  const enabled = store.enabled.bind(store), values = index.values.bind(index);
  store.enabled = () => {
    policies++;
    return enabled();
  };
  index.values = function* () {
    enumerations++;
    yield* values();
  };
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => {
      lists++;
      return Promise.resolve([]);
    },
    replyPermission: () => Promise.resolve(),
  });
  const row: IndexEntry = {
    id: "tstv1-root",
    directory: "/p",
    projectID: "p",
    title: "root",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "busy",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 1,
      childPermissions: 0,
      questions: 0,
      childQuestions: 0,
    },
  };
  try {
    store.setAuto(row.id, true);
    index.reset([row]);
    await tick();
    lists = policies = enumerations = 0;
    for (let n = 0; n < 1000; n++) {
      index.upsert({ ...row, title: `title-${n}` });
      index.applyDigest({
        id: row.id,
        deleted: null,
        revision: n + 1,
        summary: { state: "digesting", revision: n + 1 },
        turns: { upsert: {}, remove: [] },
      });
    }
    await tick();
    assertEquals({ lists, policies, enumerations }, {
      lists: 0,
      policies: 0,
      enumerations: 0,
    });
  } finally {
    feature.close();
    db.close();
  }
});

test("pending journal keys hydrate in one batch and uncertain starts are never resent", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]);
  const store = new PermissionStore(db), index = new IndexStore();
  const requests: PermissionRequest[] = Array.from(
    { length: 5 },
    (_, n) => ({
      id: `ask-${n}`,
      sessionID: "tstv1-root",
      kind: "bash",
      title: "bash",
      patterns: [`printf ${n}`],
      alwaysPatterns: [],
      time: 1,
      detail: { kind: "bash", command: `printf ${n}` },
    }),
  );
  for (const [n, request] of requests.slice(0, 3).entries()) {
    const id = store.start({
      session: request.sessionID,
      requestID: request.id,
      request: JSON.stringify(request),
      reply: "once",
      source: "auto",
      owner: request.sessionID,
    });
    if (n !== 1) {
      store.finish(
        id,
        n === 0
          ? { outcome: "confirmed" }
          : { outcome: "failed", error: "definite rejection" },
      );
    }
  }
  store.setAuto("tstv1-root", true);
  const states = store.states.bind(store),
    batches: number[] = [],
    replies: string[] = [];
  store.states = (keys) => {
    if (keys.length) batches.push(keys.length);
    return states(keys);
  };
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => Promise.resolve(requests),
    replyPermission: (reply) => {
      replies.push(reply.requestID);
      return Promise.resolve();
    },
  });
  const row: IndexEntry = {
    id: "tstv1-root",
    directory: "/p",
    projectID: "p",
    title: "root",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "busy",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 5,
      childPermissions: 0,
      questions: 0,
      childQuestions: 0,
    },
  };
  try {
    index.reset([row]);
    await tick();
    await tick();
    assertEquals(batches, [5]);
    assertEquals(replies, ["ask-2", "ask-3", "ask-4"]);
    index.upsert(row);
    await tick();
    assertEquals(
      batches,
      [5],
      "rediscovered known keys do not query journal state again",
    );
    assertEquals(replies, ["ask-2", "ask-3", "ask-4"]);
    assertEquals(
      store.list([row.id]).find((row) => row.requestID === "ask-1")!.outcome,
      "started",
    );
  } finally {
    feature.close();
    db.close();
  }
});
