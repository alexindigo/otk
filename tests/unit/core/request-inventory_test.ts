// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import {
  Finishes,
  finishesMigrations,
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Requests,
  requestsMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import type {
  RequestEvent,
  RpcMethod,
  RpcParams,
  RpcResult,
} from "@otk/protocol";
import { createRequestMetadata, requestFingerprint } from "@otk/protocol";
import {
  frecencyOptions,
  IndexStore,
  prefsOptions,
  registerFrecency,
  registerLayout,
  registerPrefs,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { test } from "../../support/resources.ts";
import { registerCatalogs } from "../../../core/features/catalogs.ts";
import { createCatalogCodecs } from "@otk/protocol";
import * as Core from "../../../core/mod.ts";
import { PermissionFeature } from "../../../core/features/approvals.ts";
import { registerDigests } from "../../../core/features/digests.ts";
import { permissionMigrations, PermissionStore } from "@otk/store";
import { cfg, fixture } from "./support.ts";

async function composition() {
  const db = new OtkDb(await fixture(), [
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
    requestsMigrations,
    prefsMigrations,
    frecencyMigrations,
    permissionMigrations,
  ], { busyms: 5000 });
  let now = 100;
  const stores = {
    projects: new Projects(db, () => ++now),
    tasks: new Tasks(db),
    seen: new Seen(db, () => ++now),
    finishes: new Finishes(db),
    templates: new ProjectTemplates(db),
  };
  const harness = {
    core: {
      getSession: (id: string) => Promise.resolve({ id, directory: "/p" }),
      identities: (ids: readonly string[]) =>
        Promise.resolve(ids.map((id) => ({ id, directory: "/p" }))),
    },
    capabilities: {},
  } as unknown as Harness;
  const registry = new RpcRegistry(harness, db);
  const inbox = new InboxFeature(
    stores,
    new IndexStore(),
    "local",
    () => Promise.resolve([]),
  );
  inbox.register(registry);
  const prefs = new Prefs(db, prefsOptions),
    frecency = new Frecency(db, frecencyOptions);
  registerPrefs(registry, harness, prefs);
  registerLayout(registry, prefs);
  registerFrecency(registry, harness, frecency);
  const receipts = new Requests(db);
  const coordinator = (fingerprint?: (canonical: string) => Promise<string>) =>
    new RequestCoordinator({
      registry,
      receipts,
      policy: cfg().requests,
      fingerprint,
    });
  return {
    db,
    stores,
    registry,
    inbox,
    prefs,
    frecency,
    receipts,
    coordinator,
  };
}

test("metadata feature registrations declare local atomic recovery and volatile read policies", async () => {
  const f = await composition();
  const local = [
    "tasks.rename",
    "tasks.reorder",
    "tasks.close",
    "tasks.removeSession",
    "projects.inactive",
    "projects.visit",
    "projects.templates",
    "prefs.set",
    "layout.patch",
    "layout.location",
  ];
  const prepared = [
    "tasks.create",
    "tasks.addSession",
    "tasks.sessions",
    "sessions.seen",
    "frecency.bump",
  ];
  const reads = [
    "inbox.get",
    "projects.list",
    "projects.scan",
    "tasks.list",
    "sessions.finishes",
    "prefs.get",
    "frecency.list",
  ];
  try {
    for (const method of local) {
      assertEquals(f.registry.policy(method)?.kind, "local", method);
    }
    for (const method of prepared) {
      assertEquals(f.registry.policy(method)?.kind, "prepared-local", method);
    }
    for (
      const method of [
        "tasks.addSession",
        "tasks.removeSession",
        "tasks.sessions",
      ]
    ) {
      assertEquals(f.registry.policy(method)?.ordering, "target", method);
    }
    assertEquals(f.registry.policy("tasks.close")?.ordering, undefined);
    for (const method of reads) {
      const policy = f.registry.policy(method);
      assertEquals(policy?.kind, "read", method);
      assertEquals(policy?.receipt({}), undefined, method);
    }
    assertEquals(
      new Set([...local, ...prepared, ...reads, "projects.add"]),
      new Set(f.registry.methods()),
    );
  } finally {
    f.inbox.close();
    f.db.close();
  }
});

test("the shipped registry inventory matches all feature conformance rows and every method declares recovery", async () => {
  const f = await composition();
  const harness = {
    ...f.registry.context.harness,
    capabilities: Object.fromEntries([
      "prompt",
      "sessionActions",
      "shell",
      "commands",
      "history",
      "files",
      "agents",
      "models",
      "resources",
      "usage",
      "permissions",
      "questions",
      "revert",
      "restore",
      "digests",
      "catalogs",
    ].map((name) => [name, {}])),
  } as unknown as Harness;
  const rpc = new RpcRegistry(harness, f.db), index = new IndexStore();
  const approvals = new PermissionFeature(
    new PermissionStore(f.db),
    index,
    harness.capabilities.permissions!,
  );
  f.inbox.register(rpc);
  registerCatalogs(
    rpc,
    harness,
    createCatalogCodecs(),
    cfg().digest.publishrows,
  );
  Core.registerPrefs(rpc, harness, f.prefs);
  Core.registerLayout(rpc, f.prefs);
  Core.registerFrecency(rpc, harness, f.frecency);
  approvals.register(rpc);
  for (
    const register of [
      Core.registerSessions,
      Core.registerSessionActions,
      Core.registerPrompt,
      Core.registerShell,
      Core.registerCommands,
      Core.registerHistory,
      Core.registerFiles,
      Core.registerAgents,
      Core.registerModels,
      Core.registerUsage,
      Core.registerResources,
      Core.registerPermissions,
      Core.registerQuestions,
      Core.registerRevert,
      registerDigests,
    ]
  ) register(rpc, harness);
  const rows = [
    "tasks.create",
    "tasks.rename",
    "tasks.reorder",
    "tasks.close",
    "tasks.addSession",
    "tasks.removeSession",
    "tasks.sessions",
    "tasks.list",
    "session.create",
    "session.rename",
    "session.delete",
    "session.fork",
    "session.compact",
    "session.revert",
    "session.restore",
    "session.prompt",
    "session.shell",
    "session.command",
    "session.abort",
    "session.get",
    "session.children",
    "session.messages",
    "permission.reply",
    "permission.auto",
    "permission.list",
    "permission.activity",
    "question.reply",
    "question.reject",
    "question.list",
    "models.list",
    "agents.list",
    "commands.list",
    "resources.list",
    "find.files",
    "usage.get",
    "history.list",
    "history.attachments",
    "catalogs.watch",
    "catalogs.refresh",
    "frecency.list",
    "frecency.bump",
    "prefs.get",
    "prefs.set",
    "layout.patch",
    "layout.location",
    "inbox.get",
    "projects.list",
    "projects.add",
    "projects.inactive",
    "projects.visit",
    "projects.scan",
    "projects.templates",
    "sessions.seen",
    "sessions.finishes",
    "digests.scope",
  ];
  try {
    assertEquals(rows.length, new Set(rows).size);
    assertEquals(rpc.methods().sort(), rows.sort());
    const descriptions = createRequestMetadata();
    assertEquals(descriptions.methods().sort(), rows.sort());
    const counts: Record<string, number> = {};
    for (const method of rpc.methods()) {
      const policy = rpc.policy(method);
      assert(policy, method);
      assertEquals(typeof policy.recover, "function", method);
      assertEquals(typeof policy.receipt, "function", method);
      assertEquals(typeof policy.scope, "function", method);
      counts[policy.kind] = (counts[policy.kind] ?? 0) + 1;
      assertEquals(
        descriptions.get(method)?.kind,
        policy.kind === "local" || policy.kind === "prepared-local" ||
          policy.kind === "native"
          ? "mutation"
          : policy.kind,
        method,
      );
    }
    assertEquals(counts, {
      read: 22,
      native: 15,
      local: 10,
      "prepared-local": 6,
      lease: 2,
    });
  } finally {
    approvals.close();
    f.inbox.close();
    f.db.close();
  }
});

for (
  const field of [
    "leftWidth",
    "rightWidth",
    "rightView",
    "projectLocations",
  ] as const
) {
  test(`layout ${field} preserves intent order across asynchronous fingerprinting`, async () => {
    const f = await composition();
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const laterHashed = Promise.withResolvers<void>();
    let count = 0;
    const coordinator = f.coordinator(async (canonical) => {
      const position = ++count;
      const fingerprint = await requestFingerprint(canonical);
      if (position === 1) {
        entered.resolve();
        await held.promise;
      } else laterHashed.resolve();
      return fingerprint;
    });
    await coordinator.start();
    const clientID = crypto.randomUUID(), window = coordinator.window();
    const events: RequestEvent[] = [];
    const recipient = {
      send: (event: RequestEvent) => events.push(event),
      lease: {
        id: "layout-order",
        signal: new AbortController().signal,
        defer() {},
      },
    };
    const firstValue = field === "leftWidth"
      ? 360
      : field === "rightWidth"
      ? 480
      : "sessions";
    const lastValue = field === "leftWidth"
      ? 200
      : field === "rightWidth"
      ? 280
      : "timeline";
    const location = (sessionID: string) => ({
      sidecarId: "local",
      directory: "/p",
      sessionID,
    });
    const admit = (value: number | string) =>
      coordinator.accept("local", {
        t: "request",
        ref: {
          id: crypto.randomUUID(),
          clientID,
          key: crypto.randomUUID(),
          window: window.id,
        },
        method: field === "projectLocations"
          ? "layout.location"
          : "layout.patch",
        params: field === "projectLocations"
          ? location(`tstv1-${value}`)
          : { [field]: value },
      }, recipient);
    try {
      const first = admit(firstValue);
      await entered.promise;
      const last = admit(lastValue);
      await laterHashed.promise;
      // Another tab can read while this sender's first fingerprint is held.
      await coordinator.accept("local", {
        t: "request",
        ref: {
          id: crypto.randomUUID(),
          clientID: crypto.randomUUID(),
          key: crypto.randomUUID(),
          window: window.id,
        },
        method: "prefs.get",
        params: {},
      }, recipient);
      await coordinator.idle();
      assertEquals(
        events.filter((event) => event.t === "request.result").length >= 1,
        true,
      );
      held.resolve();
      await Promise.all([first, last]);
      await coordinator.idle();
      assertEquals(
        events.filter((event) => event.t === "request.result").length,
        3,
      );
      assertEquals(
        f.prefs.get().shellLayout[field],
        field === "projectLocations"
          ? [location(`tstv1-${lastValue}`)]
          : lastValue,
      );
    } finally {
      held.resolve();
      await coordinator.stop();
      f.inbox.close();
      f.db.close();
    }
  });
}

test("real metadata actions settle with their writes and replay original results after coordinator restart", async () => {
  const f = await composition();
  let coordinator = f.coordinator();
  await coordinator.start();
  const window = coordinator.window(), clientID = crypto.randomUUID();
  const observations: string[] = [];
  let active:
    | { principal: string; client_id: string; intent_key: string }
    | undefined;
  const stops = [
    f.stores.tasks,
    f.stores.projects,
    f.stores.seen,
    f.stores.templates,
    f.prefs,
  ].map((store) =>
    store.listen(() => {
      if (active) observations.push(f.receipts.get(active)!.state);
    })
  );
  async function execute<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    const ref = {
      id: crypto.randomUUID(),
      clientID,
      key: crypto.randomUUID(),
      window: window.id,
    };
    active = { principal: "local", client_id: clientID, intent_key: ref.key };
    const events: RequestEvent[] = [];
    const recipient = {
      send: (event: RequestEvent) => events.push(event),
      lease: { id: "socket", signal: new AbortController().signal, defer() {} },
    };
    await coordinator.accept(
      "local",
      { t: "request", ref, method, params },
      recipient,
    );
    assertEquals(events[0]?.t, "request.accepted", method);
    // Same-key retry while queued must join, not apply a second write.
    await coordinator.accept(
      "local",
      { t: "request", ref, method, params },
      recipient,
    );
    await coordinator.idle();
    const result = events.at(-1);
    assert(
      result?.t === "request.result" && result.outcome.ok,
      JSON.stringify({ method, events }),
    );
    assertEquals(f.receipts.get(active)?.state, "succeeded", method);
    if (method === "frecency.bump") {
      assertEquals(
        JSON.parse(f.receipts.get(active)!.receipt_json!).time,
        f.frecency.list("/p")[0].last,
      );
    }
    if (method === "tasks.close") {
      assertEquals(JSON.parse(f.receipts.get(active)!.receipt_json!), {
        taskID: (params as { id: string }).id,
        closed: true,
      });
    }
    const original = result.outcome.result;
    await coordinator.stop();
    coordinator = f.coordinator();
    await coordinator.start();
    events.length = 0;
    await coordinator.accept("local", {
      t: "request.resume",
      items: [{ ref: { ...ref, id: crypto.randomUUID() }, after: 0 }],
    }, recipient);
    await coordinator.idle();
    const replay = events.at(-1);
    assert(replay?.t === "request.result" && replay.outcome.ok, method);
    assertEquals(replay.outcome.result, original, method);
    active = undefined;
    return original as RpcResult<M>;
  }
  try {
    f.stores.projects.add("local", "/p");
    const task = await execute("tasks.create", {
      directory: "/p",
      name: "perf",
    });
    await execute("tasks.rename", { id: task.id, name: "renamed" });
    await execute("tasks.addSession", { id: task.id, sessionID: "tstv1-one" });
    await execute("tasks.removeSession", {
      id: task.id,
      sessionID: "tstv1-one",
    });
    await execute("tasks.sessions", { id: task.id, sessions: ["tstv1-two"] });
    await execute("tasks.reorder", { directory: "/p", ids: [task.id] });
    await execute("tasks.close", { id: task.id });
    await execute("projects.inactive", { directory: "/p", inactive: true });
    await execute("projects.visit", { directory: "/p", active: true });
    await execute("projects.templates", { templates: ["/p/{project}"] });
    await execute("sessions.seen", { sessionID: "tstv1-two" });
    await execute("prefs.set", { key: "showCost", value: false });
    await execute("layout.patch", { rightCollapsed: false });
    await execute("layout.location", {
      sidecarId: "local",
      directory: "/p",
      sessionID: "tstv1-two",
    });
    await execute("frecency.bump", { sessionID: "tstv1-two", path: "file.ts" });
    assertEquals(f.frecency.list("/p")[0].score, 1);
    assert(observations.length > 10);
    assertEquals(new Set(observations), new Set(["succeeded"]));
    assertEquals(f.stores.tasks.list(), []);
  } finally {
    for (const stop of stops) stop();
    await coordinator.stop();
    f.inbox.close();
    f.db.close();
  }
});
