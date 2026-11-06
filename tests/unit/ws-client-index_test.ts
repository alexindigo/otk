// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionIndex } from "@otk/harness";
import {
  type DigestIndexDelta,
  type IndexEntry,
  PROTOCOL_VERSION,
  SIDECAR_VERSION,
} from "@otk/protocol";
import { serve } from "../support/http.ts";
import { waitFor } from "../support/opencode.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("raw test clients expose the public keyed index contract and recover revision gaps without item reads", async () => {
  const index = new SessionIndex();
  const metadata = {
    id: "tstv1-one",
    directory: "/p",
    projectID: "p",
    title: "One",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  index.upsertMetadata(metadata);
  let socket: WebSocket | undefined;
  const received: { t: string }[] = [];
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const upgraded = Deno.upgradeWebSocket(request);
      socket = upgraded.socket;
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        received.push(frame);
        if (frame.t === "hello") {
          socket!.send(
            JSON.stringify({
              t: "welcome",
              protocol: PROTOCOL_VERSION,
              sidecar: {
                version: SIDECAR_VERSION,
                harness: {
                  kind: "test",
                  version: "1",
                  url: "http://fixture",
                  capabilities: [],
                },
              },
            }),
          );
          socket!.send(
            JSON.stringify({
              t: "index.snapshot",
              rev: 1,
              entries: [...index.snapshotEntries()],
            }),
          );
        }
        if (frame.t === "resnapshot") {
          socket!.send(
            JSON.stringify({
              t: "index.snapshot",
              rev: 4,
              entries: [...index.snapshotEntries()],
            }),
          );
        }
      };
      return upgraded.response;
    },
  );
  const client = new WsClient(`http://127.0.0.1:${server.addr.port}`);
  try {
    await client.connect();
    await client.wait((frame) => frame.t === "index.snapshot");
    const method = Reflect.get(client, "entry");
    assertEquals(typeof method, "function");
    const entry = () =>
      Reflect.apply(method, client, [metadata.id]) as IndexEntry | undefined;
    assertEquals(entry()?.digest.state, "digesting");
    const delta: DigestIndexDelta = {
      id: metadata.id,
      revision: 1,
      summary: {
        state: "ready",
        revision: 1,
        total: {
          calls: 1,
          cost: .75,
          tokens: {
            input: 10,
            output: 2,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          contextPeak: 10,
        },
      },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    };
    index.applyDigest(delta);
    socket!.send(
      JSON.stringify({
        t: "index.patch",
        rev: 2,
        ops: [{ op: "digest", ...delta }],
      }),
    );
    await waitFor(entry, (value) => value?.digest.total?.cost === .75);
    index.applyDigest({
      ...delta,
      revision: 2,
      summary: { ...delta.summary, revision: 2 },
      deleted: { at: 3, how: "provider" },
    });
    index.upsertMetadata({ ...metadata, title: "Renamed" });
    socket!.send(
      JSON.stringify({
        t: "index.patch",
        rev: 4,
        ops: [{ op: "digest", ...delta, revision: 2 }],
      }),
    );
    await waitFor(
      entry,
      (value) =>
        value?.deleted?.how === "provider" && value.title === "Renamed",
    );
    assertEquals(received.map((frame) => frame.t), [
      "hello",
      "view",
      "resnapshot",
    ]);
  } finally {
    await client.close();
  }
});
