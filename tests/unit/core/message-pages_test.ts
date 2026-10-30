// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { loadServiceConfig } from "../../../core/config/loader.ts";
import { defaultsPath } from "../../support/config.ts";
import { fixture } from "../../support/config.ts";
import { fixturePage } from "../../support/message-pages.ts";
import { OtkDb } from "@otk/store";
import type { Harness } from "@otk/harness";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { register } from "../../../core/features/sessions.ts";
import { test } from "../../support/resources.ts";

Deno.test("message replay policy is layered and rejects unsafe budgets with precise environment names", () => {
  const value = loadServiceConfig({
    defaultsPath,
    env: { OTK_MESSAGES_REPLAYOPS: "7", OTK_MESSAGES_RETRYMS: "2500" },
  }).config;
  assertEquals(value.messages, {
    coolms: 300000,
    recoveryconcurrency: 2,
    recoverypending: 128,
    preloadms: 30000,
    concurrency: 4,
    replayops: 7,
    replaybytes: 4194304,
    retryms: 2500,
  });
});

Deno.test("message replay policy rejects zero and insufficient bookkeeping budgets", async () => {
  const inputs: Record<string, string>[] = [{ OTK_MESSAGES_REPLAYOPS: "0" }, {
    OTK_MESSAGES_REPLAYBYTES: "1",
  }];
  for (const env of inputs) {
    await assertRejects(
      () =>
        Promise.resolve().then(() => loadServiceConfig({ defaultsPath, env })),
      Error,
      "messages.replay",
    );
  }
});

test("message page registration preserves opaque cursors and per-call cancellation, rejecting bad shape before dispatch", async () => {
  const calls: unknown[] = [];
  const backend: Harness = {
    core: {
      kind: "fixture",
      version: "1",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscriptions() {},
      identities: () => Promise.resolve([]),
      getSession: (id) => Promise.resolve(fixturePage(id).session),
      listChildren: () => Promise.resolve([]),
      createSession: () => Promise.reject(new Error("read only")),
      listMessages(id, opts, signal) {
        calls.push([id, opts, signal]);
        return Promise.resolve(fixturePage(id));
      },
    },
    capabilities: {},
  };
  const store = new OtkDb(await fixture(), []);
  const rpc = new RpcRegistry(backend, store);
  register(rpc, backend);
  try {
    for (
      const params of [
        { sessionID: "bare" },
        { sessionID: "tstv1-s", limit: 10 },
        { sessionID: "tstv1-s", before: "" },
        { sessionID: "tstv1-s", before: "x".repeat(4097) },
        { sessionID: "tstv1-s", before: null },
      ]
    ) await assertRejects(() => rpc.dispatch("session.messages", params));
    assertEquals(calls, []);
    const controller = new AbortController();
    await rpc.dispatch(
      "session.messages",
      { sessionID: "tstv1-s", before: "opaque-exact+==" },
      undefined,
      { signal: controller.signal },
    );
    assertEquals(calls, [[
      "tstv1-s",
      { before: "opaque-exact+==" },
      controller.signal,
    ]]);
  } finally {
    store.close();
  }
});
