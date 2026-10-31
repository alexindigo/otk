// SPDX-License-Identifier: LGPL-3.0-only
import { assertStrictEquals } from "@std/assert";
import type { ModelCatalog } from "@otk/protocol";
import type { OtkDb } from "@otk/store";
import { register } from "../../../core/features/models.ts";
import { register as registerAgents } from "../../../core/features/agents.ts";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { stub } from "./rpc_test.ts";

Deno.test("model catalog dispatch carries its owning read signal across the capability boundary", async () => {
  const result = Promise.withResolvers<ModelCatalog>();
  let received: unknown;
  const harness = stub({
    models: {
      listModels(...args: unknown[]) {
        received = args[1];
        return result.promise;
      },
    },
  });
  const registry = new RpcRegistry(harness, {} as OtkDb);
  register(registry, harness);
  const request = new AbortController();
  const pending = registry.dispatch(
    "models.list",
    { sessionID: "tstv1-s" },
    undefined,
    { signal: request.signal },
  );
  try {
    await Promise.resolve();
    assertStrictEquals(received, request.signal);
    request.abort();
    assertStrictEquals((received as AbortSignal).aborted, true);
  } finally {
    result.resolve({ providers: [], defaultState: "unknown" });
    await pending;
  }
});

Deno.test("agent catalog dispatch preserves primary selection and its owning read signal", async () => {
  let received: unknown[] = [];
  const harness = stub({
    agents: {
      listAgents(...args: unknown[]) {
        received = args;
        return Promise.resolve([]);
      },
    },
  });
  const registry = new RpcRegistry(harness, {} as OtkDb);
  registerAgents(registry, harness);
  const request = new AbortController();
  await registry.dispatch(
    "agents.list",
    { sessionID: "tstv1-s", primary: true },
    undefined,
    { signal: request.signal },
  );
  assertStrictEquals(received[1], true);
  assertStrictEquals(received[2], request.signal);
});
