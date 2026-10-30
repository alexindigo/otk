// SPDX-License-Identifier: LGPL-3.0-only
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../support/message-pages.ts";
import { assertEquals } from "@std/assert";
import { createIndex } from "@otk/client";
import type { Harness } from "@otk/harness";
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionMetadata,
} from "@otk/protocol";
import { OtkDb, Prefs, prefsMigrations, requestsMigrations } from "@otk/store";
import { requestServices } from "../../support/core-request-services.ts";
import {
  Connections,
  IndexStore,
  prefsOptions,
  RpcRegistry,
} from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { fixture } from "./support.ts";

const metadata: SessionMetadata = {
  id: "tstv1-one",
  projectID: "p",
  directory: "/p",
  title: "Baseline",
  timeCreated: 1,
  timeUpdated: 2,
  archived: false,
  status: "idle",
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
};

async function connectionFixture() {
  const db = new OtkDb(await fixture(), [prefsMigrations, requestsMigrations]);
  const backend: Harness = {
    core: {
      kind: "test",
      version: "1",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscriptions() {},
      getSession: () => Promise.reject(new Error("Not requested")),
      createSession: () => Promise.reject(new Error("Not requested")),
      listChildren: () => Promise.resolve([]),
      listMessages: (id) => Promise.resolve(fixturePage(id)),
    },
    capabilities: {},
  };
  const index = new IndexStore(), frames: ServerFrame[] = [];
  const rpc = new RpcRegistry(backend, db),
    requests = await requestServices(rpc, db);
  const connections = new Connections(
    backend,
    index,
    "test",
    new Prefs(db, prefsOptions),
    rpc,
    fixtureMessagePolicy,
    requests,
  );
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) {
      frames.push(JSON.parse(value));
    },
    close() {},
    onmessage: null,
  } as unknown as WebSocket;
  connections.accept(socket);
  const client = createIndex();
  let cursor = 0;
  return {
    index,
    async send(value: unknown) {
      await socket.onmessage!.call(
        socket,
        new MessageEvent("message", { data: JSON.stringify(value) }),
      );
    },
    consume() {
      for (const frame of frames.slice(cursor)) {
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          assertEquals(
            client.receive("test", frame),
            true,
            JSON.stringify(frame),
          );
        }
      }
      cursor = frames.length;
      return client.get("test", metadata.id);
    },
    async close() {
      connections.close();
      await requests.coordinator.stop();
      db.close();
    },
  };
}

test("hello establishes an index baseline after already queued publications", async () => {
  const f = await connectionFixture();
  try {
    f.index.upsertMetadata(metadata);
    const hello = f.send({ t: "hello", protocol: PROTOCOL_VERSION });
    assertEquals(
      f.consume(),
      undefined,
      "The baseline is not visible before authenticated welcome finishes",
    );
    f.index.upsertMetadata({ ...metadata, title: "Live" });
    await hello;
    assertEquals(f.consume()?.title, "Live");
  } finally {
    await f.close();
  }
});

test("resnapshot orders queued index publications before the replacement baseline", async () => {
  const f = await connectionFixture();
  try {
    await f.send({ t: "hello", protocol: PROTOCOL_VERSION });
    f.consume();
    f.index.upsertMetadata(metadata);
    const snapshot = f.send({ t: "resnapshot" });
    assertEquals(f.consume()?.title, "Baseline");
    f.index.upsertMetadata({ ...metadata, title: "Live" });
    await snapshot;
    assertEquals(f.consume()?.title, "Live");
  } finally {
    await f.close();
  }
});

test("reset snapshots include observer mutations without replaying their covered publications", async () => {
  const index = new IndexStore(), client = createIndex();
  assertEquals(client.receive("test", index.snapshot()), true);
  const frames: ServerFrame[] = [];
  index.listen((frame) => frames.push(frame));
  index.observe((entry) => {
    if (entry.title === "Baseline") {
      index.upsertMetadata({ ...entry, title: "Observed" });
    }
  });
  index.reset([metadata]);
  await Promise.resolve();
  for (const frame of frames) {
    if (frame.t === "index.snapshot" || frame.t === "index.patch") {
      assertEquals(client.receive("test", frame), true, JSON.stringify(frame));
    }
  }
  assertEquals(client.get("test", metadata.id)?.title, "Observed");
});
