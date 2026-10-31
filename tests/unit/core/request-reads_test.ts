// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import type { RequestEvent } from "@otk/protocol";
import {
  registerAgents,
  registerCommands,
  registerFiles,
  registerHistory,
  registerModels,
  registerPermissions,
  registerQuestions,
  registerResources,
  registerSessions,
  registerUsage,
  RequestCoordinator,
  RpcRegistry,
} from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";

test("every body/catalog read has volatile recovery, target scope and caller cancellation", async () => {
  const cases = [
    ["session.get", { sessionID: "tstv1-one" }],
    ["session.children", { sessionID: "tstv1-one" }],
    ["session.messages", { sessionID: "tstv1-one", before: "opaque" }],
    ["models.list", { sessionID: "tstv1-one" }],
    ["agents.list", { sessionID: "tstv1-one", primary: true }],
    ["commands.list", { sessionID: "tstv1-one" }],
    ["resources.list", { sessionID: "tstv1-one" }],
    ["find.files", { sessionID: "tstv1-one", query: "file" }],
    ["usage.get", { sessionID: "tstv1-one", turnID: "turn" }],
    ["history.list", {}],
    ["history.attachments", {
      refs: [{ messageID: "message", partID: "part" }],
    }],
    ["permission.list", { sessionID: "tstv1-one" }],
    ["question.list", { sessionID: "tstv1-one" }],
  ] as const;
  for (const [method, params] of cases) {
    const db = new OtkDb(await fixture(), [requestsMigrations]);
    let observed: AbortSignal | undefined, calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    const body = { privateBody: method };
    const read = async (signal?: AbortSignal) => {
      calls++;
      observed = signal;
      await held;
      return body;
    };
    const harness = {
      core: {
        getSession: (_id: string, signal?: AbortSignal) => read(signal),
        listChildren: (_id: string, signal?: AbortSignal) => read(signal),
        listMessages: (_id: string, _opts: unknown, signal?: AbortSignal) =>
          read(signal),
      },
      capabilities: {
        models: {
          listModels: (_id: string, signal?: AbortSignal) => read(signal),
        },
        agents: {
          listAgents: (_id: string, _primary: boolean, signal?: AbortSignal) =>
            read(signal),
        },
        commands: {
          listCommands: (_id: string, signal?: AbortSignal) => read(signal),
        },
        resources: {
          listResources: (_id: string, signal?: AbortSignal) => read(signal),
        },
        files: {
          findFiles: (_id: string, _query: string, signal?: AbortSignal) =>
            read(signal),
        },
        usage: {
          getUsage: (_id: string, _turn: string, signal?: AbortSignal) =>
            read(signal),
        },
        history: {
          listHistory: (signal?: AbortSignal) => read(signal),
          attachments: (_ref: unknown, signal?: AbortSignal) => read(signal),
        },
        permissions: {
          listPermissions: (_id: string, signal?: AbortSignal) => read(signal),
        },
        questions: {
          listQuestions: (_id: string, signal?: AbortSignal) => read(signal),
        },
      },
    } as unknown as Harness;
    const active = new Set<string>();
    const registry = new RpcRegistry(harness, db, (owner, running) => {
      if (running) active.add(owner);
      else active.delete(owner);
    });
    for (
      const register of [
        registerSessions,
        registerModels,
        registerAgents,
        registerCommands,
        registerResources,
        registerFiles,
        registerUsage,
        registerHistory,
        registerPermissions,
        registerQuestions,
      ]
    ) register(registry, harness);
    const receipts = new Requests(db);
    const coordinator = new RequestCoordinator({
      registry,
      receipts,
      policy: cfg().requests,
    });
    await coordinator.start();
    const ref = {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: coordinator.window().id,
    };
    const events: RequestEvent[] = [];
    const recipient = {
      send: (event: RequestEvent) => events.push(event),
      lease: { id: "socket", signal: new AbortController().signal, defer() {} },
    };
    try {
      assertEquals(registry.policy(method)?.kind, "read", method);
      assertEquals(registry.policy(method)?.receipt(body), undefined);
      await coordinator.accept(
        "local",
        { t: "request", ref, method, params },
        recipient,
      );
      assertEquals(events[0].t, "request.accepted");
      assertEquals(calls, 0);
      await coordinator.accept(
        "local",
        { t: "request", ref, method, params },
        recipient,
      );
      // A macrotask begins the held read after acceptance.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assertEquals(calls, 1, method);
      assert(observed instanceof AbortSignal, method);
      assertEquals(
        active.size,
        0,
        `${method} must yield digest pressure while waiting`,
      );
      await coordinator.accept(
        "local",
        { t: "request.release", refs: [ref] },
        recipient,
      );
      assertEquals(observed.aborted, true, method);
      release();
      await coordinator.idle();
      const receipt = receipts.get({
        principal: "local",
        client_id: ref.clientID,
        intent_key: ref.key,
      })!;
      assertEquals(receipt.state, "released");
      assertEquals(receipt.receipt_json, null);
      assertEquals(events.some((event) => event.t === "request.result"), false);
    } finally {
      release();
      await coordinator.stop();
      db.close();
    }
  }
});
