// SPDX-License-Identifier: LGPL-3.0-only
import {
  connectRequests,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import { assert, assertEquals } from "@std/assert";
import type { ClientFrame } from "@otk/protocol";
import { createSession, SidecarConnection } from "../mod.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

Deno.test("same-session route orientation updates selection without replacing its resources", () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.subscribe = () => {};
  const owner = createSession(() => connection, () => undefined);
  const target = { sidecarId: "server", sessionID: "child" };
  try {
    owner.open(target);
    const transcript = owner.transcript, models = owner.models;
    let changes = 0;
    const release = owner.subscribe(() => changes++);
    owner.open({ ...target, rootID: "root" });
    assertEquals(owner.state.selection, { ...target, rootID: "root" });
    assertEquals(owner.transcript, transcript);
    assertEquals(owner.models, models);
    owner.open({ ...target, rootID: "root" });
    assertEquals(changes, 1, "identical route remains a no-op");
    owner.open(target);
    assertEquals(owner.state.selection, target);
    assertEquals(owner.transcript, transcript);
    assertEquals(changes, 2);
    release();
  } finally {
    owner.stop();
    connection.rpc.close();
  }
});

Deno.test("selected facade borrows a preloaded resource on return and immediately reserves the next ten", async () => {
  const frames: Extract<ClientFrame, { t: "request" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.send = (frame) => {
    if (frame.t === "request") frames.push(frame);
  };
  connectRequests(connection.rpc);
  connection.subscribe = () => {};
  const owner = createSession(() => connection, () => undefined);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const reply = async () => {
    const at = frames.findIndex((f) => f.method === "session.messages");
    assert(at >= 0, "the next page is admitted without a scroll event");
    const frame = frames.splice(at, 1)[0];
    const input = frame.params as { sessionID: string; before?: string };
    replyRequest(
      connection.rpc,
      frame,
      fixturePage(
        input.sessionID,
        Array.from(
          { length: 30 },
          (_, i) => ({
            id: `m${i}`,
            sessionID: input.sessionID,
            role: "user" as const,
            time: { created: i },
            parts: [],
          }),
        ),
        input.before,
      ),
    );
    await flush();
  };
  try {
    owner.open({ sidecarId: "server", sessionID: "a" });
    await reply();
    await reply();
    assertEquals(owner.state.content.messages.length, 20);
    owner.open({ sidecarId: "server", sessionID: "b" });
    await reply();
    await reply();
    owner.open({ sidecarId: "server", sessionID: "a" });
    await flush();
    assertEquals(owner.state.content.messages.length, 20);
    assertEquals(
      frames.filter((frame) => frame.method === "session.messages").length,
      0,
    );
  } finally {
    owner.stop();
    connection.rpc.close();
  }
});
