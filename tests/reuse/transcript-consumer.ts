// SPDX-License-Identifier: LGPL-3.0-only
import {
  createIndex,
  createTranscripts,
  SidecarConnection,
  type TranscriptClock,
} from "@otk/client";

/** Independent public-entry consumer: no UI, native or application imports. */
export async function transcriptConsumer(base: string, clock: TranscriptClock) {
  const index = createIndex();
  const owner = createTranscripts({
    connection: () => connection,
    entry: (server, id) => index.get(server, id),
    clock,
  });
  const connection = new SidecarConnection(base, {
    status() {},
    frame(frame) {
      let accepted = true;
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        accepted = index.receive("consumer", frame);
        if (!accepted) connection.send({ t: "resnapshot" });
      }
      owner.receive("consumer", frame, accepted);
    },
  }, {
    fetcher: (input, options) => {
      const headers = new Headers(options?.headers);
      headers.set("Origin", new URL(base).origin);
      return fetch(input, { ...options, headers });
    },
    socket: (url) =>
      Reflect.construct(WebSocket, [url, {
        headers: { Origin: new URL(base).origin },
      }]) as WebSocket,
  });
  const setDemand = owner.setDemand.bind(owner);
  owner.setDemand = (value) => {
    connection.view({
      directory: value.scope?.directory,
      selected: value.selected?.sessionID,
      crumbs: [],
      rows: value.sessions.map((target) => target.sessionID),
    });
    setDemand(value);
  };
  await connection.connect();
  return {
    owner,
    index,
    connection,
    stop() {
      owner.stop();
      connection.stop();
    },
  };
}
