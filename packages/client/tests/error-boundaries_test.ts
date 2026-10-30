// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createModelCatalog, RequestTracker, Rpc } from "@otk/client";
import { fixtureRequests } from "../../../tests/support/request-wire.ts";

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
    assertEquals(owner.state.error, "Could not finish this action. Try again");
    assertEquals(owner.state.value, { providers: [] });
    assertEquals(owner.state.loading, false);
    read = () => Promise.reject("catalog offline");
    await owner.refresh();
    assertEquals(owner.state.error, "Could not finish this action. Try again");
  } finally {
    owner.dispose();
  }
});

Deno.test("RPC send boundary diagnoses arbitrary transport failures and retains the unsettled intent", async () => {
  for (
    const [failure, message] of [[null, "Unknown error"], [
      "transport refused",
      "transport refused",
    ]] as const
  ) {
    const diagnostics: unknown[] = [];
    const tracker = new RequestTracker({
      send: () => {
        throw failure;
      },
      diagnostic: (cause) => diagnostics.push(cause),
    });
    const window = fixtureRequests();
    tracker.connect(window.window, window.policy.resumebatch);
    const rpc = new Rpc(() => {}, tracker);
    try {
      void message;
      const operation = rpc.start("session.get", { sessionID: "s" });
      await Promise.resolve();
      assertEquals(operation.state.connection, "reconnecting");
      assertEquals(operation.state.phase, "sending");
      assertEquals(diagnostics, [failure]);
    } finally {
      tracker.stop();
    }
  }
});
