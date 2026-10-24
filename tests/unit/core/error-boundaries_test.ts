// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { type Capabilities, type Harness, HarnessError } from "@otk/harness";
import type { PermissionReply } from "@otk/protocol";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import {
  prefsOptions,
  registerPermissions,
  registerSessions,
  RpcRegistry,
  startCore,
} from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { WsClient } from "../../support/ws-client.ts";
import { cfg, fixture } from "./support.ts";

function backend(get: (id: string) => never = () => {
  throw new Error("unused");
}, capabilities: Capabilities = {}): Harness {
  return {
    core: {
      kind: "error-boundary",
      version: "1",
      start: async () => {},
      stop: async () => {},
      subscriptions() {},
      getSession: get,
      listChildren: () => Promise.resolve([]),
      listMessages: () => Promise.resolve([]),
      createSession: () => Promise.reject(new Error("unused")),
    },
    capabilities,
  };
}

test("permission reply validates original literals before capability or journal admission", async () => {
  const db = new OtkDb(await fixture(), []), received: PermissionReply[] = [];
  const harness = backend(undefined, {
    permissions: {
      listPermissions: () => Promise.resolve([]),
      replyPermission: (input) => {
        received.push(input);
        return Promise.resolve();
      },
    },
  });
  try {
    for (const journal of [false, true]) {
      const rpc = new RpcRegistry(harness, db);
      registerPermissions(
        rpc,
        harness,
        journal
          ? (input) => {
            received.push(input);
            return Promise.resolve();
          }
          : undefined,
      );
      for (
        const reply of [
          ["once"],
          ["always"],
          ["reject"],
          { toString: () => "once" },
          null,
          0,
          true,
        ]
      ) {
        await assertRejects(
          () =>
            rpc.dispatch("permission.reply", {
              sessionID: "s",
              requestID: "r",
              reply,
            }),
          HarnessError,
          "Invalid permission reply",
        );
      }
      assertEquals(received, []);
      for (const reply of ["once", "always", "reject"]) {
        await rpc.dispatch("permission.reply", {
          sessionID: "s",
          requestID: "r",
          reply,
        });
      }
      assertEquals(
        received.map((value) => value.reply),
        ["once", "always", "reject"],
      );
      received.length = 0;
    }
  } finally {
    db.close();
  }
});

test("unknown backend failures always reach the real WS caller with nonempty text and typed codes", async () => {
  const failures = [null, undefined, "native unavailable", {
    message: "plain failure",
  }, new HarnessError("owned", "typed failure")];
  const expected = [
    "Unknown error",
    "Unknown error",
    "native unavailable",
    "plain failure",
    "typed failure",
  ];
  const root = await fixture(), settings = cfg();
  settings.server.port = 0;
  settings.auth.type = "none";
  settings.state.path = join(root, "state");
  const harness = backend((id) => {
    throw failures[Number(id)];
  });
  const db = new OtkDb(settings.state.path, [prefsMigrations]),
    rpc = new RpcRegistry(harness, db);
  registerSessions(rpc, harness);
  const app = await startCore({
    cfg: settings,
    backend: harness,
    store: db,
    prefs: new Prefs(db, prefsOptions),
    rpc,
    staticRoot: root,
  });
  const ws = new WsClient(`http://127.0.0.1:${app.server.addr.port}`);
  try {
    await ws.connect();
    for (const [index, message] of expected.entries()) {
      await assertRejects(
        () => ws.rpc("session.get", { sessionID: String(index) }),
        Error,
        `${index === 4 ? "owned" : "harness"}: ${message}`,
      );
    }
  } finally {
    await ws.close();
    await app.stop();
  }
});
