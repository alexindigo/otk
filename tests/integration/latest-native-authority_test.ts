// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createIndex, createTranscripts, SidecarConnection } from "@otk/client";
import type { ClientFrame, ServerFrame } from "@otk/protocol";
import {
  nativeBehavior,
  nativeDiscovery,
  nativePrompt,
} from "../support/native-testing.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { resources, test } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";

for (const outstanding of [false, true]) {
  test(`latest waits for real native reconnect authority and consumer output: outstanding=${outstanding}`, async () => {
    const f = await nativeBehavior(),
      session = await f.oc.createSession("Native latest authority");
    f.fake.queue({ chunks: ["Before native outage"] });
    await nativePrompt(f.oc, session.id, "Initial prompt");
    const proxy = new FreezeProxy(Number(new URL(f.oc.url).port)),
      nativeUrl = `http://127.0.0.1:${proxy.port}`;
    const server = await SidecarTest.start({
      root: f.oc.root,
      directory: f.oc.directory,
      db: f.oc.db,
      kind: f.oc.kind,
      url: nativeUrl,
      discoveryEnv: await nativeDiscovery(f.oc, nativeUrl),
    });
    const frames: ServerFrame[] = [], requests = new Set<string>();
    const held: (() => void)[] = [];
    let holding = false, nativeConnected = false;
    const index = createIndex();
    const owner = createTranscripts({
      connection: () => connection,
      entry: (server, id) => index.get(server, id),
    });
    const connection = new SidecarConnection(server.url, {
      status() {},
      frame(frame) {
        frames.push(frame);
        if (frame.t === "harness") {
          nativeConnected = frame.state === "connected";
        }
        let accepted = true;
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          accepted = index.receive("native", frame);
        }
        owner.receive("native", frame, accepted);
        return accepted;
      },
    }, {
      fetcher: (input, options) => {
        const headers = new Headers(options?.headers);
        headers.set("Origin", server.url);
        return fetch(input, { ...options, headers });
      },
      socket: (url) => {
        const socket = Reflect.construct(WebSocket, [url, {
          headers: { Origin: server.url },
        }]) as WebSocket;
        resources().defer("latest client socket", async () => {
          if (socket.readyState === WebSocket.CLOSED) return;
          const closed = new Promise<void>((resolve) =>
            socket.addEventListener("close", () => resolve(), { once: true })
          );
          socket.close();
          await closed;
        });
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          const frame = JSON.parse(String(data)) as ClientFrame;
          if (
            frame.t === "request" && frame.method === "session.messages" &&
            !(frame.params as { before?: string }).before
          ) requests.add(frame.ref.key);
          send(data);
        };
        let receive: WebSocket["onmessage"] = null;
        Object.defineProperty(socket, "onmessage", {
          configurable: true,
          get: () => receive,
          set: (value) => receive = value,
        });
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as ServerFrame;
          const page =
            frame.t === "load.chunk" && frame.data.kind === "message-page" ||
            frame.t === "request.result" && requests.has(frame.ref.key);
          const deliver = () => receive?.call(socket, event);
          if (holding && page) held.push(deliver);
          else deliver();
        });
        return socket;
      },
    });
    resources().defer("latest public consumer", () => {
      owner.stop();
      connection.stop();
    });
    connection.view({
      directory: f.oc.directory,
      selected: session.id,
      crumbs: [],
      rows: [session.id],
    });
    await connection.connect();
    await waitFor(() => connection.connected && nativeConnected, Boolean);
    const target = { sidecarId: "native", sessionID: session.id };
    owner.setDemand({
      scope: { sidecarId: "native", directory: f.oc.directory },
      sessions: [target],
      selected: target,
    });
    const transcript = owner.get(target);
    assert(transcript);
    await transcript.latest();
    const initial = transcript.state.version;
    const hasWitness = () =>
      transcript.state.messageIDs.some((id) =>
        JSON.stringify(transcript.state.messagesByID[id]).includes(
          "Created during native outage",
        )
      );
    assertEquals(hasWitness(), false);
    holding = true;
    let refetch: Promise<void> | undefined;
    if (outstanding) {
      refetch = transcript.refetch();
      await waitFor(() => held.length, (count) => count > 0);
    }
    const boundary = frames.length;
    proxy.freeze();
    proxy.disconnect();
    await waitFor(() => nativeConnected, (connected) => !connected);
    let settled = false;
    const latest = transcript.latest().then(() => {
      settled = true;
      assert(
        hasWitness(),
        "Latest resolves only after the consumer has the native outage output",
      );
    });
    f.fake.queue({ chunks: ["Created during native outage"] });
    await nativePrompt(f.oc, session.id, "Prompt while OTK is disconnected");
    assertEquals(settled, false);
    proxy.thaw();
    await waitFor(() => nativeConnected, Boolean);
    await waitFor(() => held.length, (count) => count > 0);
    assertEquals(
      settled,
      false,
      "Native connected alone cannot certify retained pre-outage authority",
    );
    assertEquals(hasWitness(), false, "Newest-page transport is still held");
    const publications = frames.slice(boundary).filter((frame) =>
      frame.t === "harness" || frame.t === "transcript.invalidated"
    );
    const invalidated = publications.findIndex((frame) =>
      frame.t === "transcript.invalidated"
    );
    const connected = publications.findIndex((frame) =>
      frame.t === "harness" && frame.state === "connected"
    );
    assert(
      invalidated >= 0 && invalidated < connected,
      "The actual native producer invalidates before publishing connected",
    );
    holding = false;
    for (const deliver of held.splice(0)) deliver();
    await latest;
    await refetch;
    assert(hasWitness());
    assert(
      JSON.stringify(transcript.state.version) !== JSON.stringify(initial),
    );
    console.log("Native latest authority", {
      native: f.oc.kind,
      outstanding,
      initial,
      accepted: transcript.state.version,
      publications,
      witness: hasWitness(),
    });
  });
}
