// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ProviderReadPort } from "@otk/harness";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { cfg } from "../support/config.ts";

Deno.test("V2 catalogs accept a transient read port without assuming digest lifetime ownership", async () => {
  const settings = cfg();
  const reads: ProviderReadPort = {
    read: () =>
      Promise.reject(new Error("Construction must not read native data")),
    release: () => {},
  };
  const adapter = new OpencodeV2ServerAdapter(
    {
      serviceFile: "/unused",
      harness: settings.harness,
      messages: settings.messages,
      digest: settings.digest,
      catalogs: settings.catalogs,
    },
    undefined,
    () => {},
    fetch,
    reads,
  );
  try {
    assert(adapter.capabilities.history);
    assertEquals(adapter.capabilities.usage, undefined);
    assertEquals(adapter.catalogs?.standalone, undefined);
  } finally {
    await adapter.core.stop();
  }
});
