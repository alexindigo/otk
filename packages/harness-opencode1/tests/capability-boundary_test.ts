// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { requireCapability } from "@otk/harness";
import { Opencode1Adapter } from "@otk/harness-opencode1";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";

declare module "@otk/protocol" {
  interface CapabilityContracts {
    "b5.uninstalled": { inspect(): string };
  }
}

/** Compile-only: an open contract contribution is not a stock implementation. */
function absentPort(adapter: Opencode1Adapter) {
  const port = adapter.capabilities["b5.uninstalled"];
  // @ts-expect-error An uninstalled contributed port cannot be used unconditionally.
  return port.inspect();
}

test("native capability consumers require their actual installed ports and reject absent extensions", async () => {
  const settings = cfg();
  settings.harness.db = `${await fixture()}/missing.db`;
  const adapter = new Opencode1Adapter(settings);
  try {
    assertEquals(typeof absentPort, "function");
    assertEquals(adapter.capabilities["b5.uninstalled"], undefined);
    assertThrows(
      () => requireCapability(adapter.capabilities, "b5.uninstalled"),
      Error,
      "unavailable",
    );
    assertEquals(
      typeof requireCapability(adapter.capabilities, "prompt").prompt,
      "function",
    );
  } finally {
    await adapter.core.stop();
  }
});
