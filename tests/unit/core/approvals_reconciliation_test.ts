// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { IndexEntry, PermissionRequest, ServerFrame } from "@otk/protocol";
import { OperationFailure } from "@otk/protocol";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import { IndexStore, RpcRegistry } from "../../../core/mod.ts";
import { fixture } from "../../support/config.ts";
import { waitFor } from "../../support/opencode.ts";
import { V2Client } from "../../../packages/harness-opencode-v2-server/client.ts";
import { V2Pending } from "../../../packages/harness-opencode-v2-server/pending.ts";

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
  digest: { state: "digesting", revision: 0, turns: {} },
  attention: {
    permissions: 1,
    childPermissions: 0,
    questions: 0,
    childQuestions: 0,
  },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("native permission 404 retires automatic reply through resync and snapshot replacement", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
    busyms: 5000,
  });
  const store = new PermissionStore(db), index = new IndexStore();
  const root = "opcv2-ses_root", location = { directory: "/owned" };
  const request = {
    id: "per_gone",
    sessionID: "ses_root",
    action: "read",
    resources: ["file.ts"],
  };
  let posts = 0;
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    new AbortController().signal,
    () => {
      posts++;
      return Promise.resolve(
        Response.json({ message: "settled elsewhere" }, { status: 404 }),
      );
    },
  );
  const pending = new V2Pending(
    () => client,
    (id) => index.getMetadata(id),
    () => {},
  );
  const feature = new PermissionFeature(store, index, pending.permissions);
  try {
    pending.acceptPermission(location, request);
    store.setAuto(root, true);
    index.reset([entry(root)]);
    await waitFor(() => pending.settled("permission", request.id), Boolean);
    for (let n = 0; n < 4; n++) {
      pending.replacePermissions(location, [request]);
      pending.acceptPermission(location, request);
      feature.connection("reconnecting");
      index.reset([entry(root)]);
      feature.connection("connected");
      await tick();
    }
    assertEquals(await pending.permissions.listPermissions(root), []);
    assertEquals(posts, 1);
    assertEquals(store.list([root], undefined, 100).length, 1);
  } finally {
    feature.close();
    db.close();
  }
});

test("proven undispatched retries back off, survive snapshots and stop after three attempts", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
    busyms: 5000,
  });
  const store = new PermissionStore(db), index = new IndexStore();
  const request: PermissionRequest = {
    id: "retry-bound",
    sessionID: "tstv1-root",
    kind: "read",
    title: "Read",
    time: 1,
    patterns: ["file.ts"],
    alwaysPatterns: [],
    detail: { kind: "generic", summary: "file.ts" },
  };
  const times: number[] = [];
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => Promise.resolve([request]),
    replyPermission: () => {
      times.push(Date.now());
      return Promise.reject(
        new OperationFailure(
          "unavailable",
          "native.unavailable",
          new Error("not dispatched"),
        ),
      );
    },
  });
  try {
    store.setAuto(request.sessionID, true);
    index.reset([entry(request.sessionID)]);
    await waitFor(() => times.length, (n) => n === 1);
    for (let n = 0; n < 3; n++) {
      feature.connection("reconnecting");
      index.reset([entry(request.sessionID)]);
      feature.connection("connected");
      await tick();
    }
    assertEquals(
      times.length,
      1,
      "Publication and readiness cannot bypass backoff",
    );
    await waitFor(() => times.length, (n) => n === 3);
    assertEquals(times[1] - times[0] >= 250, true);
    assertEquals(times[2] - times[1] >= 1000, true);
    for (let n = 0; n < 3; n++) {
      feature.connection("reconnecting");
      index.reset([entry(request.sessionID)]);
      feature.connection("connected");
      await tick();
    }
    assertEquals(times.length, 3);
  } finally {
    feature.close();
    db.close();
  }
});

test("startup pending permission waits for native readiness and is answered exactly once", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
    busyms: 5000,
  });
  const store = new PermissionStore(db), index = new IndexStore();
  const request: PermissionRequest = {
    id: "startup",
    sessionID: "tstv1-root",
    kind: "edit",
    title: "Edit",
    time: 1,
    patterns: ["file.ts"],
    alwaysPatterns: [],
    detail: { kind: "generic", summary: "file.ts" },
  };
  let ready = false, attempts = 0, lists = 0;
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => {
      lists++;
      return Promise.resolve([request]);
    },
    replyPermission: () => {
      attempts++;
      return ready ? Promise.resolve() : Promise.reject(
        new OperationFailure(
          "unavailable",
          "native.unavailable",
          new Error("Not connected yet"),
        ),
      );
    },
  });
  try {
    feature.connection("connecting");
    store.setAuto("tstv1-root", true);
    index.reset([entry("tstv1-root")]);
    await tick();
    assertEquals([
      lists,
      attempts,
      store.list([request.sessionID], undefined, 100).length,
    ], [0, 0, 0]);
    ready = true;
    feature.connection("connected");
    await waitFor(
      () => store.confirmed(request.sessionID, request.id),
      Boolean,
    );
    feature.connection("connected");
    index.upsert(entry("tstv1-root"));
    await tick();
    assertEquals(attempts, 1);
    assertEquals(
      store.list([request.sessionID], undefined, 100).map((row) => row.outcome),
      ["confirmed"],
    );
  } finally {
    feature.close();
    db.close();
  }
});

test("unavailable auto replies retry only after connection readiness; real refusals stay failed once", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
    busyms: 5000,
  });
  const store = new PermissionStore(db), index = new IndexStore();
  const request: PermissionRequest = {
    id: "retry",
    sessionID: "tstv1-root",
    kind: "edit",
    title: "Edit",
    time: 1,
    patterns: ["file.ts"],
    alwaysPatterns: [],
    detail: { kind: "generic", summary: "file.ts" },
  };
  let attempts = 0;
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => Promise.resolve([request]),
    replyPermission: () => {
      attempts++;
      return Promise.reject(
        new OperationFailure(
          attempts === 1 ? "unavailable" : "rejected",
          attempts === 1 ? "native.unavailable" : "native.rejected",
          new Error("diagnostic only"),
          {
            reason: attempts === 1
              ? "Native connection lost before dispatch"
              : "Policy refused this reply",
            status: 403,
          },
        ),
      );
    },
  });
  try {
    store.setAuto(request.sessionID, true);
    index.reset([entry(request.sessionID)]);
    await waitFor(() => attempts, (n) => n === 1);
    await tick();
    assertEquals(store.unconfirmed(request.sessionID, request.id), false);
    for (let n = 0; n < 4; n++) {
      index.upsert(entry(request.sessionID));
      await tick();
    }
    assertEquals(attempts, 1);
    feature.connection("reconnecting");
    feature.connection("connected");
    await waitFor(() => attempts, (n) => n === 2);
    await tick();
    for (let n = 0; n < 4; n++) {
      feature.connection("reconnecting");
      feature.connection("connected");
      index.upsert(entry(request.sessionID));
      await tick();
    }
    assertEquals(attempts, 2);
    const records = store.list([request.sessionID], undefined, 100);
    assertEquals(records.map((row) => row.outcome), ["failed", "failed"]);
    assertEquals(records[0].error, "Policy refused this reply");
    const failure = JSON.parse(records[0].failure!);
    assertEquals(failure.facts.reason, "Policy refused this reply");
    assertEquals(failure.facts.action, "permission.reply");
    assertEquals(
      failure.facts.recovery,
      "Review this request before trying again.",
    );
    assertEquals(failure.retry, "new-intent");
  } finally {
    feature.close();
    db.close();
  }
});

test("uncertain automatic delivery is never retried after reconnect", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
    busyms: 5000,
  });
  const store = new PermissionStore(db), index = new IndexStore();
  const request: PermissionRequest = {
    id: "unknown",
    sessionID: "tstv1-root",
    kind: "edit",
    title: "Edit",
    time: 1,
    patterns: ["file.ts"],
    alwaysPatterns: [],
    detail: { kind: "generic", summary: "file.ts" },
  };
  let attempts = 0;
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => Promise.resolve([request]),
    replyPermission: () => {
      attempts++;
      return Promise.reject(
        new OperationFailure(
          "unknown",
          "native.unknown",
          new Error("Lost after dispatch"),
        ),
      );
    },
  });
  try {
    store.setAuto(request.sessionID, true);
    index.reset([entry(request.sessionID)]);
    await waitFor(() => attempts, (n) => n === 1);
    await tick();
    for (let n = 0; n < 4; n++) {
      feature.connection("reconnecting");
      feature.connection("connected");
      index.upsert(entry(request.sessionID));
      await tick();
    }
    assertEquals(attempts, 1);
    assertEquals(store.unconfirmed(request.sessionID, request.id), true);
    assertEquals(
      store.list([request.sessionID], undefined, 100).map((row) => row.outcome),
      ["started"],
    );
  } finally {
    feature.close();
    db.close();
  }
});

test("automatic refusal is attempted once per identity across changed details, absence and index replacements", async () => {
  const db = new OtkDb(await fixture(), [permissionMigrations], {
    busyms: 5000,
  });
  const store = new PermissionStore(db), index = new IndexStore();
  let request: PermissionRequest = {
    id: "ask",
    sessionID: "tstv1-root",
    kind: "bash",
    title: "bash",
    time: 1,
    patterns: ["printf exact"],
    alwaysPatterns: [],
    detail: { kind: "bash", command: "printf exact" },
  };
  let attempts = 0, lists = 0, present = true;
  const feature = new PermissionFeature(store, index, {
    listPermissions: () => {
      lists++;
      return Promise.resolve(present ? [request] : []);
    },
    replyPermission: () => {
      attempts++;
      return Promise.reject(
        new OperationFailure(
          "rejected",
          "native.rejected",
          new Error("held failure"),
        ),
      );
    },
  });
  try {
    store.setAuto("tstv1-root", true);
    index.reset([entry("tstv1-root")]);
    await waitFor(
      () => store.list(["tstv1-root"], undefined, 101)[0]?.outcome,
      (s) => s === "failed",
    );
    for (let n = 0; n < 12; n++) {
      index.upsert({ ...entry("tstv1-other"), timeUpdated: n + 2 });
      await tick();
    }
    assertEquals(
      [attempts, store.list(["tstv1-root"], undefined, 101).length],
      [1, 1],
    );
    assertEquals(
      lists,
      1,
      "unrelated updates do not rediscover the failed request",
    );
    index.upsert(entry("tstv1-root"));
    await tick();
    assertEquals(
      lists,
      2,
      "a relevant inventory signal rediscovers it without another reply",
    );
    assertEquals(attempts, 1);
    request = {
      ...request,
      detail: { kind: "bash", command: "printf changed" },
    };
    index.upsert(entry("tstv1-root"));
    await tick();
    assertEquals(attempts, 1);
    index.reset([entry("tstv1-root")]);
    await tick();
    assertEquals(attempts, 1);
    present = false;
    index.upsert(entry("tstv1-root"));
    await tick();
    present = true;
    index.reset([entry("tstv1-root")]);
    feature.connection("reconnecting");
    feature.connection("connected");
    await tick();
    assertEquals(attempts, 1);
    request = { ...request, id: "new-identity" };
    index.upsert(entry("tstv1-root"));
    await waitFor(() => attempts, (n) => n === 2);
  } finally {
    feature.close();
    db.close();
  }
});

test("server rejects helper policy and removes deleted session policy durably without journal-driven policy revisions", async () => {
  const path = await fixture(),
    db = new OtkDb(path, [permissionMigrations], { busyms: 5000 });
  const store = new PermissionStore(db), index = new IndexStore();
  const capability = {
    listPermissions: () => Promise.resolve([]),
    replyPermission: () => Promise.resolve(),
  };
  const feature = new PermissionFeature(store, index, capability);
  const harness = {
    core: {
      identities: (ids: readonly string[]) =>
        Promise.resolve(
          ids.map((id) => ({
            id,
            directory: "/owned",
            ...(id === "tstv1-child" ? { parentID: "tstv1-root" } : {}),
          })),
        ),
      getSession: (id: string) =>
        Promise.resolve({
          ...entry(id, id === "tstv1-child" ? "tstv1-root" : undefined),
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
        rpc.dispatch("permission.auto", {
          sessionID: "tstv1-child",
          enabled: true,
        }),
      Error,
      "helper",
    );
    assertEquals(store.enabled(), []);
    index.reset([entry("tstv1-root"), entry("tstv1-child", "tstv1-root")]);
    await rpc.dispatch("permission.auto", {
      sessionID: "tstv1-root",
      enabled: true,
    });
    const revision = feature.get().revision;
    const id = store.start({
      session: "tstv1-child",
      requestID: "record",
      request: "{}",
      reply: "once",
      source: "auto",
      owner: "tstv1-root",
    }, ["tstv1-root"]);
    store.finish(id, { outcome: "confirmed" });
    assertEquals(
      feature.get().revision,
      revision,
      "journal writes do not mutate policy revision",
    );
    assertEquals(frames.filter((f) => f.t === "approvals").length, 1);
    assertEquals(frames.filter((f) => f.t === "approval.activity"), [
      { t: "approval.activity", sessions: ["tstv1-child", "tstv1-root"] },
      { t: "approval.activity", sessions: ["tstv1-child", "tstv1-root"] },
    ]);
    index.remove("tstv1-root");
    await tick();
    assertEquals(store.enabled(), []);
    assertEquals(feature.get().revision, revision + 1);
    assertEquals(frames.at(-1), { t: "approvals", approvals: feature.get() });
    store.setAuto("tstv1-outside-window", true);
    index.remove("tstv1-outside-window");
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
  const reopened = new OtkDb(path, [permissionMigrations], { busyms: 5000 });
  try {
    assertEquals(new PermissionStore(reopened).enabled(), []);
  } finally {
    reopened.close();
  }
});
