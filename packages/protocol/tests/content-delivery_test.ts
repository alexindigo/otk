// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { ContentDeliveryDiagnostics } from "../content-delivery.ts";

Deno.test("content boundary diagnostics retain the last accepted clock after a rejected gap", () => {
  const diagnostics = new ContentDeliveryDiagnostics("browser");
  const clock = { epoch: "source", seq: 3 };
  diagnostics.record({
    sessionID: "s",
    operation: "page",
    clock,
    state: "accepted",
  });
  diagnostics.record({
    sessionID: "s",
    operation: "part.upsert",
    clock: { ...clock, seq: 5 },
    previous: clock,
    state: "gap",
  });
  assertEquals(diagnostics.get("s").accepted, clock);
  assertEquals(diagnostics.get("s").last?.state, "gap");
  clock.seq = 99;
  assertEquals(diagnostics.get("s").last?.previous?.seq, 3);
  const snapshot = diagnostics.get("s");
  snapshot.accepted!.seq = 100;
  assertEquals(diagnostics.get("s").accepted?.seq, 3);
  diagnostics.clear();
  assertEquals(diagnostics.get("s"), {});
});
