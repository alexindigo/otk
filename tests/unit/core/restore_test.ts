// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../../support/resources.ts";
import { HarnessError } from "@otk/harness";
import { OtkDb } from "@otk/store";
import { registerRevert, RpcRegistry } from "../../../core/mod.ts";
import { fixture } from "./support.ts";
import { stub } from "./rpc_test.ts";
test("restore is independently capability gated and validates the session before forwarding", async () => {
  const db = new OtkDb(await fixture(), []);
  try {
    const absent = stub({
      revert: { revert: () => Promise.reject(new Error("Unexpected revert")) },
    });
    const unavailable = new RpcRegistry(absent, db);
    registerRevert(unavailable, absent);
    assertEquals(
      (await assertRejects(
        () => unavailable.dispatch("session.restore", {}),
        HarnessError,
      )).code,
      "method",
    );
    const calls: string[] = [];
    const harness = stub({
      restore: {
        restore: (id) => {
          calls.push(id);
          return harness.core.getSession(id);
        },
      },
    });
    const rpc = new RpcRegistry(harness, db);
    registerRevert(rpc, harness);
    for (const params of [{}, { sessionID: "" }, { sessionID: 42 }]) {
      assertEquals(
        (await assertRejects(
          () => rpc.dispatch("session.restore", params),
          HarnessError,
        )).code,
        "params",
      );
    }
    assertEquals(calls, []);
    assertEquals(
      await rpc.dispatch("session.restore", { sessionID: "s" }),
      await harness.core.getSession("s"),
    );
    assertEquals(calls, ["s"]);
  } finally {
    db.close();
  }
});
