// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createModelCatalog, Rpc } from "@otk/client";

Deno.test("catalog failure publication normalizes unknown values and keeps last-good data", async () => {
  const failure = Promise.withResolvers<never>();
  let read = () => Promise.resolve({ providers: [] });
  const owner = createModelCatalog({
    connection: () => ({ key: "one", connected: true, available: true }),
    load: () => read(),
  });
  try {
    await owner.ready();
    read = () => failure.promise;
    const pending = owner.refresh();
    failure.reject(null);
    await pending;
    assertEquals(owner.state.error, "Unknown error");
    assertEquals(owner.state.value, { providers: [] });
    assertEquals(owner.state.loading, false);
    read = () => Promise.reject("catalog offline");
    await owner.refresh();
    assertEquals(owner.state.error, "catalog offline");
  } finally {
    owner.dispose();
  }
});

Deno.test("RPC send boundary returns an Error for arbitrary injected transport failures", async () => {
  for (
    const [failure, message] of [[null, "Unknown error"], [
      "transport refused",
      "transport refused",
    ]] as const
  ) {
    const rpc = new Rpc(() => {
      throw failure;
    });
    try {
      await assertRejects(
        () => rpc.call("session.get", { sessionID: "s" }),
        Error,
        message,
      );
    } finally {
      rpc.close();
    }
  }
});
