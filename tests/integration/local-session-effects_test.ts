// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ApprovalSnapshot, RequestEvent } from "@otk/protocol";
import { nativeFixture } from "../support/native-fixture.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";

test("local policy disable settles behind sessions.seen while stock native readiness is held offline", async () => {
  const f = await nativeFixture();
  const proxy = new FreezeProxy(f.oc.port);
  let client: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Offline local effects" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.port}` },
    });
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("permission.auto", {
      sessionID: session.id,
      enabled: true,
    });
    const welcome = client.frames.find((frame) => frame.t === "welcome");
    assert(welcome?.t === "welcome");
    const ref = {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: welcome.requests.window.id,
    };
    proxy.freeze();
    client.send({
      t: "request",
      ref,
      method: "sessions.seen",
      params: { sessionID: session.id },
    });
    await client.wait((frame) =>
      frame.t === "request.progress" && frame.ref.key === ref.key &&
      frame.progress.phase === "running"
    );
    const beforeDisable = client.frames.length;
    const disable = {
      ...ref,
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
    };
    client.send({
      t: "request",
      ref: disable,
      method: "permission.auto",
      params: { sessionID: session.id, enabled: false },
    });
    await client.wait((frame) =>
      frame.t === "request.accepted" && frame.ref.key === disable.key
    );
    // This later independent read is a dispatch barrier, not a deadline race
    // against the native read's liveness bound. Disable must already have run.
    await client.rpc("permission.activity", { sessionID: session.id });
    const completed = client.frames.find((frame) =>
      frame.t === "request.result" && frame.ref.key === disable.key
    );
    assert(
      completed?.t === "request.result" && completed.outcome.ok,
      "Local disable must settle before the later independent read while native remains held",
    );
    const result = completed.outcome.result as ApprovalSnapshot;
    assertEquals(result.enabled.includes(session.id), false);
    // The independent local consumer sees the committed state before native is released.
    assert(
      client.frames.slice(beforeDisable).some((frame) =>
        frame.t === "approvals" && !frame.approvals.enabled.includes(session.id)
      ),
    );
    const seen = client.frames.filter((frame): frame is RequestEvent =>
      frame.t.startsWith("request.")
    ).find((frame) =>
      frame.ref.key === ref.key && frame.t === "request.result"
    );
    assertEquals(seen, undefined);
    proxy.thaw();
    const finished = await client.wait((frame) =>
      frame.t === "request.result" && frame.ref.key === ref.key
    );
    assert(finished.t === "request.result" && finished.outcome.ok);
  } finally {
    proxy.thaw();
    await client?.close();
    await f.stop();
    await proxy.stop();
  }
});
