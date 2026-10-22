// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { IndexEntry, PermissionRequest, ServerFrame } from "@otk/protocol";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import { IndexStore, RpcRegistry } from "../../../core/mod.ts";
import { fixture } from "../../support/config.ts";
import { waitFor } from "../../support/opencode.ts";

const entry = (id: string, parentID?: string): IndexEntry => ({
  id,
  parentID,
  directory: "/owned",
  projectID: "p",
  title: id,
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "busy",
  attention: {
    permissions: 1,
    childPermissions: 0,
    questions: 0,
    childQuestions: 0,
  },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("automatic failure is attempted once across unrelated index changes; request and connection generations permit retry", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations]);
  const store = new PermissionStore(db), index = new IndexStore();
  let request: PermissionRequest = {
    id: "ask",
    sessionID: "root",
    kind: "bash",
    title: "bash",
    time: 1,
    patterns: ["printf exact"],
    alwaysPatterns: [],
    detail: { kind: "bash", command: "printf exact" },
  };
  let attempts = 0, lists = 0;
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => {
      lists++;
      return Promise.resolve([request]);
    },
    replyPermission: () => {
      attempts++;
      return Promise.reject(new Error("held failure"));
    },
  });
  try {
    store.setAuto("root", true);
    index.reset([entry("root")]);
    await waitFor(
      () => store.list(["root"])[0]?.outcome,
      (s) => s === "failed",
    );
    for (let n = 0; n < 12; n++) {
      index.upsert({ ...entry("other"), timeUpdated: n + 2 });
      await tick();
    }
    assertEquals([attempts, store.list(["root"]).length], [1, 1]);
    assertEquals(
      lists > 1,
      true,
      "the failed request was actually rediscovered",
    );
    request = {
      ...request,
      detail: { kind: "bash", command: "printf changed" },
    };
    index.upsert(entry("root"));
    await waitFor(() => store.list(["root"]).length, (n) => n === 2);
    await tick();
    assertEquals(attempts, 2);
    index.reset([entry("root")]);
    await waitFor(() => store.list(["root"]).length, (n) => n === 3);
    await tick();
    assertEquals(attempts, 3);
  } finally {
    feature.close();
    db.close();
  }
});

test("server rejects helper policy and removes deleted session policy durably without journal-driven policy revisions", async () => {
  const path = await fixture(), db = new OtkDb(path, [permissionMigrations]);
  const store = new PermissionStore(db), index = new IndexStore();
  const capability = {
    listPermissions: () => Promise.resolve([]),
    replyPermission: () => Promise.resolve(),
  };
  const feature = new PermissionFeature(store, index, capability);
  const harness = {
    core: {
      getSession: (id: string) =>
        Promise.resolve({
          ...entry(id, id === "child" ? "root" : undefined),
          time: { created: 1, updated: 1 },
        }),
    },
    capabilities: { permissions: capability },
  } as unknown as Harness;
  const rpc = new RpcRegistry(harness, db), frames: ServerFrame[] = [];
  feature.register(rpc);
  feature.listen((frame) => frames.push(frame));
  try {
    await assertRejects(
      () =>
        rpc.dispatch("permission.auto", { sessionID: "child", enabled: true }),
      Error,
      "helper",
    );
    assertEquals(store.enabled(), []);
    index.reset([entry("root"), entry("child", "root")]);
    await rpc.dispatch("permission.auto", { sessionID: "root", enabled: true });
    const revision = feature.get().revision;
    const id = store.start({
      session: "child",
      requestID: "record",
      request: "{}",
      reply: "once",
      source: "auto",
      owner: "root",
    }, ["root"]);
    store.finish(id, { outcome: "confirmed" });
    assertEquals(
      feature.get().revision,
      revision,
      "journal writes do not mutate policy revision",
    );
    assertEquals(frames.filter((f) => f.t === "approvals").length, 1);
    assertEquals(frames.filter((f) => f.t === "approval.activity"), [
      { t: "approval.activity", sessions: ["child", "root"] },
      { t: "approval.activity", sessions: ["child", "root"] },
    ]);
    index.remove("root");
    await tick();
    assertEquals(store.enabled(), []);
    assertEquals(feature.get().revision, revision + 1);
    assertEquals(frames.at(-1), { t: "approvals", approvals: feature.get() });
    store.setAuto("outside-window", true);
    index.remove("outside-window");
    await tick();
    assertEquals(
      store.enabled(),
      [],
      "Explicit deletion removes policy even without a live index row",
    );
  } finally {
    feature.close();
    db.close();
  }
  const reopened = new OtkDb(path, [permissionMigrations]);
  try {
    assertEquals(new PermissionStore(reopened).enabled(), []);
  } finally {
    reopened.close();
  }
});
