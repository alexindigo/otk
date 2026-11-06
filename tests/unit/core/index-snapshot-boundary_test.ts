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
  const db = new OtkDb(await fixture(), [prefsMigrations, requestsMigrations], {
    busyms: 5000,
  });
  const backend: Harness = {
    core: {
      kind: "test",
      version: "1",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      subscriptions() {},
      identities: () => Promise.resolve([]),
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
      const frame: ServerFrame = JSON.parse(value);
      frames.push(frame);
      if (
        (frame.t === "index.snapshot" || frame.t === "index.patch") &&
        frame.epoch !== undefined
      ) {
        queueMicrotask(() =>
          void socket.onmessage!.call(
            socket,
            new MessageEvent("message", {
              data: JSON.stringify({
                t: "index.applied",
                epoch: frame.epoch,
                rev: frame.rev,
              }),
            }),
          )
        );
      }
    },
    close() {},
    onmessage: null,
  } as unknown as WebSocket;
  connections.accept(socket);
  const client = createIndex();
  let cursor = 0;
  return {
    index,
    connections,
    frames,
    async send(value: unknown) {
      if ((value as { t: string }).t === "hello") {
        value = {
          ...(value as object),
          view: {
            epoch: 1,
            directory: "/p",
            selected: metadata.id,
            crumbs: [],
            rows: [],
          },
        };
      }
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

test("ancestor-routed attention follows its newly leased child metadata", async () => {
  const f = await connectionFixture();
  try {
    f.index.upsertMetadata(metadata);
    await f.send({ t: "hello", protocol: PROTOCOL_VERSION });
    await f.send({ t: "subscribe", sessionID: metadata.id });
    await f.send({
      t: "view",
      epoch: 2,
      directory: "/p",
      selected: metadata.id,
      crumbs: ["tstv1-child"],
      rows: [],
    });
    const at = f.frames.length;
    f.index.upsertMetadata({
      ...metadata,
      id: "tstv1-child",
      parentID: metadata.id,
    });
    f.connections.content("tstv1-child", {
      op: "permission.upsert",
      request: {
        id: "request",
        sessionID: "tstv1-child",
        kind: "bash",
        title: "Child permission",
        patterns: [],
        alwaysPatterns: [],
        detail: { kind: "bash", command: "true" },
        time: 1,
      },
    });
    const frames = f.frames.slice(at);
    assertEquals(frames.map((frame) => frame.t), ["index.patch", "content"]);
    const patch = frames[0];
    assertEquals(
      patch.t === "index.patch" &&
        patch.ops.some((op) =>
          op.op === "upsert" && op.entry.id === "tstv1-child"
        ),
      true,
    );
  } finally {
    await f.close();
  }
});

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
