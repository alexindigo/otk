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
    assertEquals(
      (await assertRejects(
        () => unavailable.dispatch("session.fork", {}),
        HarnessError,
      )).code,
      "method",
    );
    const calls: unknown[] = [];
    const harness = stub({
      sessionActions: {
        compact: () => Promise.reject(new Error("Unexpected compact")),
        fork: (id, through) => {
          calls.push(["fork", id, through]);
          return harness.core.getSession(id);
        },
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
    const created: string[] = [];
    registerSessionActions(
      rpc,
      harness,
      (directory) => created.push(directory),
    );
    for (
      const params of [{}, { sessionID: "", title: "x" }, {
        sessionID: "tstv1-s",
        title: "  ",
      }, { sessionID: "tstv1-s", title: "x".repeat(201) }]
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
    await rpc.dispatch("session.rename", {
      sessionID: "tstv1-s",
      title: " New ",
    });
    assertEquals(calls, [["tstv1-s", "New"]]);
    assertEquals(
      (await assertRejects(
        () => rpc.dispatch("session.delete", { sessionID: "" }),
        HarnessError,
      )).code,
      "params",
    );
    assertEquals(
      await rpc.dispatch("session.delete", { sessionID: "tstv1-s" }),
      null,
    );
    assertEquals(calls, [["tstv1-s", "New"], ["delete", "tstv1-s"]]);
    for (
      const params of [{}, { sessionID: "" }, {
        sessionID: "tstv1-s",
        through: "",
      }, {
        sessionID: "tstv1-s",
        through: 1,
      }]
    ) {
      assertEquals(
        (await assertRejects(
          () => rpc.dispatch("session.fork", params),
          HarnessError,
        )).code,
        "params",
      );
    }
    const result = await rpc.dispatch("session.fork", {
      sessionID: "tstv1-s",
      through: "last",
    });
    assertEquals(calls.at(-1), ["fork", "tstv1-s", "last"]);
    const expected = await harness.core.getSession("tstv1-s");
    assertEquals(result, expected);
    assertEquals(created, [expected.directory]);
  } finally {
    db.close();
  }
});

test("compact validates model references and session identity and requires its advertised capability", async () => {
  const db = new OtkDb(await fixture(), []);
  try {
    const absent = stub(), unavailable = new RpcRegistry(absent, db);
    registerSessionActions(unavailable, absent);
    assertEquals(
      (await assertRejects(
        () => unavailable.dispatch("session.compact", {}),
        HarnessError,
      )).code,
      "method",
    );
    const calls: unknown[] = [];
    const harness = stub({
      sessionActions: {
        rename: () => Promise.reject(new Error("Unexpected rename")),
        remove: () => Promise.reject(new Error("Unexpected removal")),
        fork: () => Promise.reject(new Error("Unexpected fork")),
        compact: (id, model) => {
          calls.push([id, model]);
          return Promise.resolve();
        },
      },
    });
    const rpc = new RpcRegistry(harness, db);
    registerSessionActions(rpc, harness);
    for (
      const params of [
        {},
        { sessionID: "tstv1-s" },
        { sessionID: "", model: { provider: "p", model: "m" } },
        { sessionID: "tstv1-s", model: { provider: "p" } },
        { sessionID: "tstv1-s", model: { provider: "", model: "m" } },
        { sessionID: "tstv1-s", model: { provider: 1, model: "m" } },
      ]
    ) {
      assertEquals(
        (await assertRejects(
          () => rpc.dispatch("session.compact", params),
          HarnessError,
        )).code,
        "params",
      );
    }
    assertEquals(calls, []);
    assertEquals(
      await rpc.dispatch("session.compact", {
        sessionID: "tstv1-s",
        model: { provider: "p", model: "m" },
      }),
      null,
    );
    assertEquals(calls, [["tstv1-s", { provider: "p", model: "m" }]]);
  } finally {
    db.close();
  }
});
