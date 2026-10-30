// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import type {
  ContentSession,
  OperationContext,
  RequestEvent,
} from "@otk/protocol";
import { OperationFailure } from "@otk/protocol";
import {
  Finishes,
  finishesMigrations,
  OtkDb,
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
import {
  IndexStore,
  registerCommands,
  registerPermissions,
  registerPrompt,
  registerQuestions,
  registerRevert,
  registerSessionActions,
  registerSessions,
  registerShell,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { InboxFeature } from "../../../core/features/inbox.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";

test("every native feature fences its backend effect, checkpoints only metadata and resumes without redispatch", async () => {
  const root = await fixture();
  const db = new OtkDb(root, [
    requestsMigrations,
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
  ]);
  const receipts = new Requests(db), calls = new Map<string, number>();
  let uncertain = false;
  const base: ContentSession = {
    id: "tstv1-root",
    directory: root,
    projectID: "p",
    title: "Root",
    archived: false,
    time: { created: 1, updated: 2 },
  };
  const sessions = new Map([[base.id, base]]);
  async function effect<T>(
    method: string,
    operation: OperationContext | undefined,
    value: T,
  ): Promise<T> {
    assert(operation, `${method} must pass its execution context`);
    const record = receipts.get({
      principal: "local",
      client_id: operation.key.clientID,
      intent_key: operation.key.key,
    });
    assert(
      record?.dispatched_at !== null && record?.dispatched_at !== undefined,
      `${method} must fence before invoking any backend`,
    );
    await operation.beforeEffect();
    calls.set(method, (calls.get(method) ?? 0) + 1);
    if (uncertain) {
      throw new OperationFailure(
        "unknown",
        "native.unknown",
        new Error("lost native response"),
      );
    }
    return value;
  }
  const harness: Harness = {
    core: {
      kind: "external",
      version: "1",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscriptions() {},
      getSession: (id) => Promise.resolve(sessions.get(id) ?? base),
      listChildren: () => Promise.resolve([]),
      listMessages: () => Promise.reject(new Error("No body read needed")),
      createSession: (_input, operation) =>
        effect("session.create", operation, { ...base, id: "tstv1-created" }),
    },
    capabilities: {
      prompt: {
        prompt: (_input, operation) =>
          effect("session.prompt", operation, undefined),
        abort: (_id, operation) =>
          effect("session.abort", operation, undefined),
      },
      shell: {
        shell: (_input, operation) =>
          effect("session.shell", operation, undefined),
      },
      commands: {
        listCommands: () => Promise.resolve([]),
        command: (_input, operation) =>
          effect("session.command", operation, undefined),
      },
      sessionActions: {
        compact: (_id, _model, operation) =>
          effect("session.compact", operation, undefined),
        fork: (_id, _through, operation) =>
          effect("session.fork", operation, { ...base, id: "tstv1-fork" }),
        rename: (_id, title, operation) =>
          effect("session.rename", operation, { ...base, title }),
        remove: (_id, operation) =>
          effect("session.delete", operation, undefined),
      },
      revert: {
        revert: (_id, messageID, operation) =>
          effect("session.revert", operation, {
            ...base,
            revert: {
              messageID,
              messageCount: 1,
              files: [],
              prompt: {
                input: "private prompt must never be stored",
                mode: "normal",
                parts: [],
                time: 1,
              },
            },
          }),
      },
      restore: {
        restore: (_id, operation) => effect("session.restore", operation, base),
      },
      permissions: {
        listPermissions: () => Promise.resolve([]),
        replyPermission: (_input, operation) =>
          effect("permission.reply", operation, undefined),
      },
      questions: {
        listQuestions: () => Promise.resolve([]),
        answerQuestion: (_id, answers, operation) =>
          effect(
            answers ? "question.reply" : "question.reject",
            operation,
            undefined,
          ),
      },
    },
  };
  const registry = new RpcRegistry(harness, db);
  const inbox = new InboxFeature(
    {
      projects: new Projects(db),
      tasks: new Tasks(db),
      seen: new Seen(db),
      finishes: new Finishes(db),
      templates: new ProjectTemplates(db),
    },
    new IndexStore(),
    "local",
    () => Promise.resolve([]),
  );
  inbox.register(registry);
  for (
    const register of [
      registerSessions,
      registerSessionActions,
      registerPrompt,
      registerShell,
      registerCommands,
      registerPermissions,
      registerQuestions,
      registerRevert,
    ]
  ) register(registry, harness);
  const cases = [
    ["session.create", { directory: root }],
    ["session.fork", { sessionID: base.id }],
    ["session.rename", { sessionID: base.id, title: "Renamed" }],
    ["session.prompt", {
      sessionID: base.id,
      parts: [{ kind: "text", text: "private prompt" }],
      mode: "normal",
    }],
    ["session.shell", {
      sessionID: base.id,
      command: "private command",
      agent: "build",
    }],
    ["session.command", {
      sessionID: base.id,
      command: "private slash",
      arguments: "private arguments",
    }],
    ["session.compact", {
      sessionID: base.id,
      model: { provider: "p", model: "m" },
    }],
    ["session.abort", { sessionID: base.id }],
    ["session.revert", { sessionID: base.id, messageID: "boundary" }],
    ["session.restore", { sessionID: base.id }],
    ["permission.reply", {
      sessionID: base.id,
      requestID: "permission",
      reply: "once",
      message: "private feedback",
    }],
    ["question.reply", {
      requestID: "question",
      answers: [["private answer"]],
    }],
    ["question.reject", { requestID: "other-question" }],
    ["session.delete", { sessionID: base.id }],
    ["projects.add", { directory: root }],
  ] as const;
  let coordinator = new RequestCoordinator({
    registry,
    receipts,
    policy: cfg().requests,
  });
  await coordinator.start();
  try {
    assertEquals(
      cases.filter(([method]) => registry.policy(method)?.kind !== "native")
        .map(([method]) => method),
      [],
    );
    for (const [method, params] of cases) {
      const ref = {
        id: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        key: crypto.randomUUID(),
        window: coordinator.window().id,
      };
      const events: RequestEvent[] = [];
      const recipient = {
        send: (event: RequestEvent) => events.push(event),
        lease: {
          id: "socket",
          signal: new AbortController().signal,
          defer() {},
        },
      };
      const before = new Map(calls);
      await coordinator.accept(
        "local",
        { t: "request", ref, method, params },
        recipient,
      );
      assertEquals(events[0].t, "request.accepted");
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
      const counter = method === "projects.add" ? "session.create" : method;
      assertEquals(calls.get(counter), (before.get(counter) ?? 0) + 1, method);
      const record = receipts.get({
        principal: "local",
        client_id: ref.clientID,
        intent_key: ref.key,
      })!;
      assertEquals(record.state, "succeeded");
      assert(!JSON.stringify(record).includes("private"), method);
      await coordinator.stop();
      coordinator = new RequestCoordinator({
        registry,
        receipts,
        policy: cfg().requests,
      });
      await coordinator.start();
      events.length = 0;
      await coordinator.accept("local", {
        t: "request.resume",
        items: [{ ref, after: 0 }],
      }, recipient);
      await coordinator.idle();
      assertEquals(calls.get(counter), (before.get(counter) ?? 0) + 1, method);
      const resumed = events.at(-1);
      assert(resumed?.t === "request.result" && resumed.outcome.ok, method);
    }
    uncertain = true;
    for (const [method, params] of cases) {
      const ref = {
        id: crypto.randomUUID(),
        clientID: crypto.randomUUID(),
        key: crypto.randomUUID(),
        window: coordinator.window().id,
      };
      const events: RequestEvent[] = [];
      const recipient = {
        send: (event: RequestEvent) => events.push(event),
        lease: {
          id: "replacement",
          signal: new AbortController().signal,
          defer() {},
        },
      };
      const counter = method === "projects.add" ? "session.create" : method;
      const before = calls.get(counter) ?? 0;
      await coordinator.accept(
        "local",
        { t: "request", ref, method, params },
        recipient,
      );
      await coordinator.idle();
      assertEquals(calls.get(counter), before + 1, method);
      assertEquals(
        events.some((event) =>
          event.t === "request.result" && !event.outcome.ok
        ),
        false,
        method,
      );
      await coordinator.stop();
      coordinator = new RequestCoordinator({
        registry,
        receipts,
        policy: cfg().requests,
      });
      await coordinator.start();
      await coordinator.accept(
        "local",
        { t: "request", ref, method, params },
        recipient,
      );
      await coordinator.idle();
      assertEquals(
        calls.get(counter),
        before + 1,
        `${method} must never resend a fenced uncertain effect`,
      );
      assertEquals(
        events.some((event) =>
          event.t === "request.result" && !event.outcome.ok
        ),
        false,
        method,
      );
    }
  } finally {
    await coordinator.stop();
    inbox.close();
    db.close();
  }
});
