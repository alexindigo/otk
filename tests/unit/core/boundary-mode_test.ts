// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb, type RequestRecord, requestsMigrations } from "@otk/store";
import type { ContentSession } from "@otk/protocol";
import { registerRevert, RpcRegistry } from "../../../core/mod.ts";
import type { RequestExecution } from "../../../core/requests/types.ts";
import { fixture } from "./support.ts";
import { stub } from "./rpc_test.ts";
import { test } from "../../support/resources.ts";

test("a boundary ID cannot certify file mode; lost Restore reconciles only through its clear-owned settlement read", async () => {
  const db = new OtkDb(await fixture(), [requestsMigrations], { busyms: 5000 });
  try {
    let clears = 0, waits = 0;
    const gate = Promise.withResolvers<ContentSession>();
    const harness = stub({
      revert: {
        revert: () => {
          throw new Error("Unexpected mutation");
        },
      },
      revertCode: {
        revert: () => {
          throw new Error("Unexpected mutation");
        },
      },
      restore: {
        restore: () => {
          clears++;
          throw new Error("Recovery must never clear again");
        },
        settle: (_id, after) => {
          waits++;
          assertEquals(after, 42);
          return gate.promise;
        },
      },
    });
    const base = await harness.core.getSession("tstv1-s");
    let current: ContentSession = {
      ...base,
      revert: { messageID: "same-boundary", messageCount: 1, files: [] },
    };
    harness.core.getSession = () => Promise.resolve(current);
    const rpc = new RpcRegistry(harness, db);
    registerRevert(rpc, harness);
    const record: RequestRecord = {
      principal: "local",
      client_id: "client",
      intent_key: "intent",
      window_id: "window",
      method: "session.revertCode",
      fingerprint: "hash",
      execution: "native",
      state: "reconciling",
      seq: 1,
      accepted_at: 1,
      updated_at: 1,
      retention_until: 1000,
      dispatched_at: 2,
      owner_run: null,
      scope_session: "tstv1-s",
      scope_directory: null,
      scope_resource: "boundary",
      progress_code: "checking-outcome",
      progress_completed: null,
      progress_total: null,
      receipt_kind: "session-boundary-intent",
      receipt_json: "",
      error_code: null,
      error_retry: null,
      error_field: null,
      diagnostic_id: null,
    };
    const execution: RequestExecution = {
      signal: new AbortController().signal,
      key: { key: "intent", clientID: "client", window: "window" },
      progress() {},
      checkpoint: () => Promise.resolve(),
      beforeEffect: () => Promise.resolve(),
      wait: (pending) => pending,
      local() {
        throw new Error("No local mutation");
      },
    };
    for (const mode of [undefined, "messages", "code"]) {
      record.receipt_json = JSON.stringify({
        sessionID: "tstv1-s",
        messageID: "same-boundary",
        mode,
      });
      assertEquals(
        (await rpc.policy("session.revertCode")!.recover(
          rpc.context,
          record,
          execution,
        )).state,
        "pending",
      );
    }
    current = base;
    record.method = "session.restore";
    record.receipt_json = JSON.stringify({
      sessionID: "tstv1-s",
      messageID: null,
      mode: "restore",
    });
    assertEquals(
      (await rpc.policy("session.restore")!.recover(
        rpc.context,
        record,
        execution,
      )).state,
      "pending",
    );
    assertEquals(waits, 0);
    record.receipt_json = JSON.stringify({
      sessionID: "tstv1-s",
      messageID: null,
      mode: "restore",
      after: 42,
    });
    let done = false;
    const pending = rpc.policy("session.restore")!.recover(
      rpc.context,
      record,
      execution,
    ).then((result) => {
      done = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(done, false);
    gate.resolve(base);
    assertEquals((await pending).state, "complete");
    assertEquals([clears, waits], [0, 1]);
  } finally {
    db.close();
  }
});
