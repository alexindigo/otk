// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createApprovals, type InboxRpc } from "@otk/client";
import type {
  PermissionActivity,
  PermissionActivityPage,
  ServerFrame,
} from "@otk/protocol";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const welcome: ServerFrame = {
  t: "welcome",
  protocol: 13,
  sidecar: {
    version: "test",
    harness: { kind: "test", version: "1", url: "http://127.0.0.1" },
  },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("approval resource follows authoritative policy, coalesces activity and rejects stale reads and RPC acknowledgements", async () => {
  const reads: {
    method: string;
    params: unknown;
    value: ReturnType<typeof deferred<unknown>>;
  }[] = [];
  const rpc: InboxRpc = {
    call: ((method: string, params: unknown) => {
      const value = deferred<unknown>();
      reads.push({ method, params, value });
      return value.promise;
    }) as InboxRpc["call"],
  };
  const model = createApprovals(
    rpc,
    (id) => id === "child" ? { parentID: "root" } : undefined,
  );
  model.receive(welcome);
  model.receive({
    t: "approvals",
    approvals: { enabled: ["root"], revision: 1 },
  });
  assertEquals(model.owner("child"), "root");
  assertEquals(model.owner("outside"), undefined);
  const first = model.loadActivity("root"), joined = model.loadActivity("root");
  assertEquals(first, joined);
  await tick();
  assertEquals(reads.length, 1);
  model.receive({
    t: "approvals",
    approvals: { enabled: ["root"], revision: 2 },
  });
  model.receive({ t: "approval.activity", sessions: ["root", "child"] });
  reads[0].value.resolve({ entries: [], before: 20 });
  await tick();
  assertEquals(reads.length, 2);
  const activity: PermissionActivity = {
    id: 1,
    time: 1,
    source: "auto",
    reply: "once",
    outcome: "confirmed",
    request: {
      id: "permission",
      sessionID: "root",
      kind: "bash",
      title: "bash",
      patterns: ["printf exact"],
      alwaysPatterns: [],
      time: 1,
      detail: { kind: "bash", command: "printf exact" },
    },
  };
  reads[1].value.resolve({ entries: [activity], before: 10 });
  await first;
  assertEquals(model.state.activity.before, 10);
  assertEquals(
    model.activityFor("new").entries,
    [],
    "A replacement session cannot render the previous session's page while its selection effect is pending",
  );
  await model.selectActivity("root");
  await tick();
  assertEquals(
    reads.length,
    2,
    "Reactive selection re-delivery must not create another resource read",
  );
  const setting = model.setAuto("root", false);
  assertEquals(model.owner("root"), "root", "No optimistic policy mutation");
  await tick();
  model.receive({ t: "approvals", approvals: { enabled: [], revision: 4 } });
  reads[2].value.resolve({ enabled: ["root"], revision: 3 });
  await setting;
  assertEquals(
    model.owner("root"),
    undefined,
    "Older RPC result cannot override a newer broadcast",
  );
  await tick();
  void model.loadActivity("root");
  await tick();
  const stale = reads.at(-1)!;
  model.receive(welcome);
  model.receive({
    t: "approvals",
    approvals: { enabled: ["other"], revision: 0 },
  });
  await tick();
  const current = reads.at(-1)!;
  stale.value.resolve({ entries: [], before: 999 });
  current.value.resolve({ entries: [] });
  await tick();
  assertEquals(model.state.activity.before, undefined);
  assertEquals(model.owner("other"), "other");
  model.stop();
});

Deno.test("activity invalidation is family-scoped and independent of policy revision", async () => {
  let reads = 0;
  const model = createApprovals({
    call: (() => {
      reads++;
      return Promise.resolve({ entries: [] });
    }) as InboxRpc["call"],
  }, () => undefined);
  model.receive({ t: "approvals", approvals: { enabled: [], revision: 0 } });
  await model.selectActivity("selected");
  model.receive({
    t: "approval.activity",
    sessions: ["other", "other-helper"],
  });
  model.receive({
    t: "approvals",
    approvals: { enabled: ["other"], revision: 1 },
  });
  await tick();
  assertEquals(
    reads,
    1,
    "unrelated activity and policy cannot refetch the selected family",
  );
  model.receive({ t: "approval.activity", sessions: ["selected", "helper"] });
  await tick();
  assertEquals(reads, 2);
  assertEquals(model.state.snapshot.revision, 1);
  model.stop();
});

Deno.test("approval activity paging uses strict server cursors and session replacement cannot publish old activity", async () => {
  const pending: ReturnType<typeof deferred<PermissionActivityPage>>[] = [],
    params: unknown[] = [];
  const model = createApprovals({
    call: ((_method: string, input: unknown) => {
      params.push(input);
      const value = deferred<PermissionActivityPage>();
      pending.push(value);
      return value.promise;
    }) as InboxRpc["call"],
  }, () => undefined);
  model.receive({ t: "approvals", approvals: { enabled: [], revision: 1 } });
  const old = model.loadActivity("old");
  await tick();
  const next = model.loadActivity("new");
  await tick();
  const entry = (id: number, sessionID: string): PermissionActivity => ({
    id,
    time: 1,
    source: "auto",
    reply: "once",
    outcome: "confirmed",
    request: {
      id: String(id),
      sessionID,
      kind: "bash",
      title: "bash",
      patterns: ["printf exact"],
      alwaysPatterns: [],
      time: 1,
      detail: { kind: "bash", command: "printf exact" },
    },
  });
  pending[0].resolve({ entries: [entry(999, "old")], before: 999 });
  await old;
  pending[1].resolve({ entries: [entry(42, "new")], before: 42 });
  await next;
  assertEquals(model.state.activity.sessionID, "new");
  const more = model.loadActivity("new", true);
  await tick();
  assertEquals(params.at(-1), { sessionID: "new", before: 42 });
  pending[2].resolve({ entries: [entry(1, "new")] });
  await more;
  assertEquals(model.state.activity.before, undefined);
  assertEquals(model.state.activity.entries.map((entry) => entry.id), [42, 1]);
  model.stop();
});
