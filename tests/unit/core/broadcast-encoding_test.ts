// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import { PROTOCOL_VERSION, type ServerFrame } from "@otk/protocol";
import { OtkDb, Prefs, prefsMigrations, requestsMigrations } from "@otk/store";
import {
  Connections,
  IndexStore,
  prefsOptions,
  RpcRegistry,
} from "../../../core/mod.ts";
import { requestServices } from "../../support/core-request-services.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../support/message-pages.ts";
import { fixture } from "./support.ts";
import { test } from "../../support/resources.ts";

test("shared broadcasts and subscribed content encode once for sixteen consumers", async () => {
  const db = new OtkDb(await fixture(), [prefsMigrations, requestsMigrations]);
  const backend: Harness = {
    core: {
      kind: "test",
      version: "1",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscriptions() {},
      identities: () => Promise.resolve([]),
      getSession: () => Promise.reject(new Error("not requested")),
      createSession: () => Promise.reject(new Error("not requested")),
      listChildren: () => Promise.resolve([]),
      listMessages: (id) => Promise.resolve(fixturePage(id)),
    },
    capabilities: {},
  };
  const rpc = new RpcRegistry(backend, db),
    requests = await requestServices(rpc, db);
  const sections: string[] = [];
  const connections = new Connections(
    backend,
    new IndexStore(),
    "test",
    new Prefs(db, prefsOptions),
    rpc,
    fixtureMessagePolicy,
    requests,
    [],
    (name) => sections.push(name),
  );
  const received: ServerFrame[][] = [];
  try {
    for (let n = 0; n < 16; n++) {
      const frames: ServerFrame[] = [];
      received.push(frames);
      const socket = {
        readyState: WebSocket.OPEN,
        close() {},
        send(data: string) {
          frames.push(JSON.parse(data));
        },
        onmessage: null,
      } as unknown as WebSocket;
      connections.accept(socket);
      for (
        const frame of [{ t: "hello", protocol: PROTOCOL_VERSION }, {
          t: "subscribe",
          sessionID: n < 8 ? "tstv1-one" : "tstv1-other",
        }]
      ) {
        await socket.onmessage!.call(
          socket,
          new MessageEvent("message", { data: JSON.stringify(frame) }),
        );
      }
    }
    sections.length = 0;
    const baseline = received.map((frames) => frames.length);
    connections.broadcast({ t: "harness", state: "connected" });
    connections.content("tstv1-one", {
      op: "permission.remove",
      sessionID: "tstv1-one",
      requestID: "ask",
    });
    assertEquals(sections, ["serialize:harness", "serialize:content"]);
    assertEquals(
      received.map((frames, n) =>
        frames.slice(baseline[n]).map((frame) => frame.t)
      ),
      Array.from(
        { length: 16 },
        (_, n) => n < 8 ? ["harness", "content"] : ["harness"],
      ),
    );
  } finally {
    connections.close();
    await requests.coordinator.stop();
    db.close();
  }
});
