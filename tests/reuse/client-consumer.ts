// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContentState,
  createCurrentClient,
  createIndex,
  createSession,
  SidecarConnection,
} from "@otk/client";

/** A standalone plain-Deno consumer, with no framework or application imports. */
export async function observeReply(
  baseUrl: string,
  directory: string,
  text: string,
  expected: string,
): Promise<{ content: ContentState; ops: number; indexed: boolean }> {
  const index = createIndex();
  const session = createSession(
    () => connection,
    (id, sessionID) => index.state.entries[`${id}/${sessionID}`],
  );
  const current = createCurrentClient(
    () => session.state.selection,
    () => connection,
  );
  let ops = 0;
  const ready = Promise.withResolvers<void>();
  const connection = new SidecarConnection(baseUrl, {
    status(state, error) {
      if (
        state === "protocol mismatch" || state === "login required" ||
        state === "setup required"
      ) ready.reject(new Error(error ?? state));
    },
    frame(frame) {
      if (frame.t === "welcome") ready.resolve();
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (!index.receive("core", frame)) connection.send({ t: "resnapshot" });
      }
      if (frame.t === "content") ops++;
      session.receive("core", frame);
    },
  }, {
    socket: (url) =>
      // Deno's native constructor supports headers; root checks also use DOM types.
      Reflect.construct(WebSocket, [url, {
        headers: { Origin: new URL(baseUrl).origin },
      }]) as WebSocket,
  });
  const wait = async (predicate: () => boolean): Promise<void> => {
    const until = Date.now() + 30_000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error("Client outcome timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(
      () => ready.reject(new Error("Welcome timed out")),
      15_000,
    );
    await connection.connect();
    await ready.promise;
    clearTimeout(timer);
    const created = await connection.rpc.call<{ id: string }>(
      "session.create",
      { directory },
    );
    session.open({ sidecarId: "core", sessionID: created.id });
    await wait(() => !session.state.loading);
    if (session.state.error) throw new Error(session.state.error);
    await current.call<void>("session.prompt", {
      mode: "normal",
      parts: [{ kind: "text", text }],
    });
    await wait(() =>
      session.state.content.messages.some((message) =>
        message.role === "assistant" && message.time.completed !== undefined &&
        JSON.stringify(message.parts).includes(expected)
      )
    );
    await wait(() => !!index.state.entries[`core/${created.id}`]);
    return {
      content: structuredClone(session.state.content),
      ops,
      indexed: true,
    };
  } finally {
    clearTimeout(timer);
    session.stop();
    connection.stop();
  }
}
