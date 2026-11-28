// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createApprovals } from "@otk/client";

Deno.test("approval attention stays waiting until authoritative policy and explicit liveness are available", () => {
  const model = createApprovals(
    { call: () => Promise.reject(new Error("No RPC expected")) },
    (id) =>
      id === "root" ? {} : id === "helper" ? { parentID: "root" } : undefined,
  );
  assertEquals(model.owner("helper"), undefined);
  assertEquals([
    model.canEnable("root"),
    model.canEnable("helper"),
    model.canEnable("missing"),
  ], [true, false, false]);
  model.receive({
    t: "approvals",
    approvals: { enabled: ["root"], revision: 0 },
  });
  assertEquals(model.owner("helper"), "root");
  model.stop();
});
