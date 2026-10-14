// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  CapabilityRegistry,
  type Harness,
  HarnessError,
  requireCapability,
} from "../mod.ts";

Deno.test("a core-only harness needs no optional implementation; registry snapshots preserve capability identity", async () => {
  const registry = new CapabilityRegistry();
  const harness: Harness = {
    core: {
      kind: "minimal",
      version: "1",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscriptions: () => {},
      getSession: () => Promise.reject(new Error("not found")),
      listChildren: () => Promise.resolve([]),
      listMessages: () => Promise.resolve([]),
      createSession: () => Promise.reject(new Error("read only")),
    },
    capabilities: registry.capabilities,
  };
  assertEquals(await harness.core.listChildren("root"), []);
  assertEquals(registry.names(), []);
  const missing = assertThrows(
    () => requireCapability(harness.capabilities, "history"),
    HarnessError,
  );
  assertEquals(missing.code, "capability");
  const history = {
    listHistory: () => Promise.resolve([]),
    attachment: () => Promise.reject(new Error("gone")),
  };
  registry.register("history", history);
  assertEquals(registry.names(), ["history"]);
  assertEquals(requireCapability(registry.capabilities, "history"), history);
  assertEquals(
    await requireCapability(registry.capabilities, "history").listHistory(),
    [],
  );
  assertThrows(() => registry.register("history", history), HarnessError);
  assertEquals(harness.capabilities.history, undefined);
});
