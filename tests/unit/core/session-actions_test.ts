// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../../support/resources.ts";
import { HarnessError } from "@otk/harness";
import { OtkDb } from "@otk/store";
import { registerSessionActions, RpcRegistry } from "../../../core/mod.ts";
import { fixture } from "./support.ts";
import { stub } from "./rpc_test.ts";

test("session actions are capability-gated and validate before forwarding a trimmed title", async () => {
  const db = new OtkDb(await fixture(), []);
  const absent = stub(), unavailable = new RpcRegistry(absent, db);
  registerSessionActions(unavailable, absent);
  try {
    assertEquals(
      (await assertRejects(
        () => unavailable.dispatch("session.rename", {}),
        HarnessError,
      )).code,
      "method",
    );
    assertEquals(
      (await assertRejects(
        () => unavailable.dispatch("session.delete", {}),
        HarnessError,
      )).code,
      "method",
    );
    const calls: unknown[] = [];
    const harness = stub({
      sessionActions: {
        remove: (id) => {
          calls.push(["delete", id]);
          return Promise.resolve();
        },
        rename: async (id, title) => {
          calls.push([id, title]);
          return { ...(await harness.core.getSession(id)), title };
        },
      },
    });
    const rpc = new RpcRegistry(harness, db);
    registerSessionActions(rpc, harness);
    for (
      const params of [{}, { sessionID: "", title: "x" }, {
        sessionID: "s",
        title: "  ",
      }, { sessionID: "s", title: "x".repeat(201) }]
    ) {
      assertEquals(
        (await assertRejects(
          () => rpc.dispatch("session.rename", params),
          HarnessError,
        )).code,
        "params",
      );
    }
    assertEquals(calls, []);
    await rpc.dispatch("session.rename", { sessionID: "s", title: " New " });
    assertEquals(calls, [["s", "New"]]);
    assertEquals(
      (await assertRejects(
        () => rpc.dispatch("session.delete", { sessionID: "" }),
        HarnessError,
      )).code,
      "params",
    );
    assertEquals(
      await rpc.dispatch("session.delete", { sessionID: "s" }),
      null,
    );
    assertEquals(calls, [["s", "New"], ["delete", "s"]]);
  } finally {
    db.close();
  }
});
