// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { RequestEvent, RequestRef } from "@otk/protocol";
import { coreBackendFixture } from "../support/core-backend.ts";
import { WsClient } from "../support/ws-client.ts";
import { tempDir, test } from "../support/resources.ts";

test("selected wire acknowledges and resumes a held actual task intent after socket replacement", async () => {
  const root = await tempDir("selected-request-wire-"),
    f = await coreBackendFixture(root);
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const original = f.app.backend.core.identities;
  let reads = 0;
  f.app.backend.core.identities = async (ids) => {
    reads++;
    entered.resolve();
    await held.promise;
    return original(ids);
  };
  const first = new WsClient(f.url);
  await first.connect();
  const welcome = first.frames.find((frame) => frame.t === "welcome")!;
  assert(welcome.t === "welcome");
  assert(
    welcome.requests,
    "The selected request-event wire must advertise admission and liveness policy",
  );
  const ref: RequestRef = {
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    id: crypto.randomUUID(),
    window: welcome.requests.window.id,
  };
  let second: WsClient | undefined;
  try {
    first.send({
      t: "request",
      ref,
      method: "tasks.create",
      params: { directory: root, name: "perf", sessions: [f.session.id] },
    });
    const accepted = await first.wait((frame) =>
      frame.t === "request.accepted" && frame.ref.key === ref.key
    );
    assertEquals(accepted.t, "request.accepted");
    await entered.promise;
    first.send({ t: "request.resume", items: [{ ref, after: 0 }] });
    await first.close();
    second = new WsClient(f.url);
    await second.connect();
    const attempt = { ...ref, id: crypto.randomUUID() };
    second.send({ t: "request.resume", items: [{ ref: attempt, after: 0 }] });
    await second.wait((frame) =>
      frame.t === "request.accepted" && frame.ref.key === ref.key
    );
    assertEquals(
      second.frames.some((frame) =>
        frame.t === "request.result" && frame.ref.key === ref.key
      ),
      false,
    );
    held.resolve();
    const result = await second.wait((frame) =>
      frame.t === "request.result" && frame.ref.key === ref.key
    ) as Extract<RequestEvent, { t: "request.result" }>;
    assert(result.outcome.ok);
    assertEquals(reads, 1);
    const tasks = await second.rpc<{ id: string; name: string }[]>(
      "tasks.list",
      { directory: root },
    );
    assertEquals(tasks.length, 1);
    assertEquals(tasks[0].name, "perf");
    assertEquals(tasks[0].id, (result.outcome.result as { id: string }).id);
  } finally {
    held.resolve();
    await first.close();
    await second?.close();
    await f.app.stop();
  }
});
