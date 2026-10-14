// SPDX-License-Identifier: LGPL-3.0-only
import { createIndex, createSession, SidecarConnection } from "@otk/client";

if (import.meta.main) {
  const [baseUrl, sessionID] = Deno.args;
  if (!baseUrl || !sessionID) {
    throw new Error("Usage: example.ts CORE_URL SESSION_ID");
  }
  const index = createIndex();
  const session = createSession(
    () => connection,
    (id, sessionID) => index.state.entries[`${id}/${sessionID}`],
  );
  const connection = new SidecarConnection(baseUrl, {
    status(state, error) {
      console.error(state, error ?? "");
    },
    frame(frame) {
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (!index.receive("core", frame)) connection.send({ t: "resnapshot" });
      }
      session.receive("core", frame);
      if (frame.t === "welcome") session.open({ sidecarId: "core", sessionID });
    },
  }, {
    socket: (url) =>
      // Deno's documented native options extend the browser DOM constructor.
      Reflect.construct(WebSocket, [url, {
        headers: { Origin: new URL(baseUrl).origin },
      }]) as WebSocket,
  });
  session.subscribe((state) => console.log(JSON.stringify(state.content)));
  const stop = () => {
    session.stop();
    connection.stop();
  };
  Deno.addSignalListener("SIGINT", () => {
    stop();
    Deno.exit();
  });
  await connection.connect();
}
