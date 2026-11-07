// SPDX-License-Identifier: LGPL-3.0-only
import {
  connectRequests,
  type FixtureRequest,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import { assert, assertEquals } from "@std/assert";
import { createSession, SidecarConnection } from "../mod.ts";
import type { ContentClock, ContentOp, MessagePage } from "@otk/protocol";

const policy = {
  coolms: 300000,
  recoveryconcurrency: 2,
  recoverypending: 128,
  preloadms: 30000,
  concurrency: 4,
  replayops: 2,
  replaybytes: 4096,
  prefetchms: 300000,
  prefetchbytes: 67108864,
  retryms: 1000,
};
const clock = { epoch: "test", seq: 0 };
const page = (older: string | null = null): MessagePage => ({
  sessionID: "opcv1-s",
  version: { generation: 0, revision: 0 },
  clock,
  from: clock,
  older,
  session: {
    id: "opcv1-s",
    directory: "/p",
    projectID: "p",
    title: "S",
    archived: false,
    time: { created: 1, updated: 1 },
  },
  items: Array.from(
    { length: 10 },
    (_, n) => ({
      id: `m${n}`,
      sessionID: "opcv1-s",
      role: "user",
      time: { created: n },
      parts: [],
    }),
  ),
  prompt: {
    id: "outside-page",
    agent: "plan",
    model: { provider: "p", model: "m" },
    variant: "high",
  },
  catchup: [],
  turns: {},
  helpers: {},
  recovering: [],
});
function fixture(concurrency = policy.concurrency) {
  const frames: FixtureRequest[] = [];
  const connection = new SidecarConnection("http://fixture.invalid", {
    status() {},
    frame() {},
  }, { messages: { ...policy, concurrency } });
  connection.send = (frame) => {
    if (frame.t === "request") frames.push(frame);
  };
  connectRequests(connection.rpc);
  connection.supports = () => false;
  connection.subscribe = () => {};
  const owner = createSession(() => connection, () => undefined);
  const event = (event: ContentOp, stamp: ContentClock) =>
    owner.receive("server", {
      t: "content",
      sessionID: "opcv1-s",
      event,
      clock: stamp,
    });
  const reply = (result: MessagePage) => {
    const frame = frames.find((f) => f.method === "session.messages")!;
    assert(frame);
    replyRequest(connection.rpc, frame, result);
    frames.splice(frames.indexOf(frame), 1);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stop = () => {
    owner.stop();
    connection.rpc.close();
  };
  return { owner, event, reply, frames, settle, stop };
}

Deno.test("selected page installs coordinated metadata and latest prompt outside newest10 without session.get", async () => {
  const f = fixture();
  try {
    f.owner.open({ sidecarId: "server", sessionID: "opcv1-s" });
    assertEquals(f.frames.map((f) => f.method), ["session.messages"]);
    f.reply(page());
    await f.settle();
    assertEquals(f.owner.state.content.messages.length, 10);
    assertEquals(f.owner.state.exhausted, true);
    assertEquals(f.owner.latestPrompt()?.id, "outside-page");
    await f.owner.older();
    assertEquals(f.frames, []);
  } finally {
    f.stop();
  }
});

Deno.test("@load @messages cancelled settled page releases admission for the next resource", async () => {
  const f = fixture(1);
  try {
    const selection = { sidecarId: "server", sessionID: "opcv1-s" };
    f.owner.open(selection);
    f.reply(page());
    // Retire between RPC settlement and the boundary owner's continuation.
    f.owner.open();
    f.owner.removeServer("server");
    f.owner.open(selection);
    await f.settle();
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      1,
    );
  } finally {
    f.stop();
  }
});

Deno.test("@load @messages page coverage rejects wrong boundaries, epochs and retired request completion", async () => {
  const f = fixture();
  try {
    f.owner.open({ sidecarId: "server", sessionID: "opcv1-s" });
    const request = f.frames.find((frame) =>
      frame.method === "session.messages"
    )!;
    const load: import("@otk/protocol").LoadCoverage = {
      id: request.ref.key,
      scope: { kind: "session-messages", sessionID: "opcv1-s" },
      boundary: { kind: "page", limit: 10 },
      generation: "pending",
      revision: 0,
      state: "loading",
    };
    const chunk = {
      t: "load.chunk" as const,
      request: request.ref,
      epoch: 0,
      load,
      data: { kind: "message-page" as const, page: null },
    };
    f.owner.receive("server", chunk);
    assertEquals(f.owner.transcript?.state.load?.state, "loading");
    f.owner.receive("server", {
      ...chunk,
      epoch: 99,
      load: { ...load, state: "complete", revision: 1 },
    });
    f.owner.receive("server", {
      ...chunk,
      load: {
        ...load,
        state: "complete",
        revision: 2,
        boundary: { kind: "page", limit: 10, before: "other" },
      },
    });
    f.owner.receive("server", {
      ...chunk,
      request: { ...request.ref, key: "retired" },
      load: { ...load, state: "complete", revision: 3 },
    });
    assertEquals(f.owner.transcript?.state.load?.state, "loading");
    f.reply(
      {
        ...page(),
        load: { ...load, revision: 1, generation: "source", state: "complete" },
      } as MessagePage,
    );
    await f.settle();
    assertEquals(f.owner.transcript?.state.load?.state, "complete");
    assertEquals(f.owner.state.content.messages.length, 10);
  } finally {
    f.stop();
  }
});

Deno.test("@load @messages atomic page push paints before scalar completion without replaying bodies or clocks", async () => {
  const f = fixture();
  try {
    f.owner.open({ sidecarId: "server", sessionID: "opcv1-s" });
    const request = f.frames.find((frame) =>
      frame.method === "session.messages"
    )!;
    const load: import("@otk/protocol").LoadCoverage = {
      id: request.ref.key,
      scope: { kind: "session-messages", sessionID: "opcv1-s" },
      boundary: { kind: "page", limit: 10 },
      generation: "source",
      revision: 1,
      state: "loading",
    };
    f.owner.receive("server", {
      t: "load.chunk",
      request: request.ref,
      epoch: 0,
      load,
      data: { kind: "message-page", page: page() },
    });
    await f.settle();
    assertEquals(f.owner.state.content.messages.length, 10);
    assertEquals(f.owner.state.loading, false);
    assertEquals(f.owner.transcript?.state.load?.state, "loading");
    f.event({
      op: "message.upsert",
      message: {
        id: "live",
        sessionID: "opcv1-s",
        role: "user",
        time: { created: 30 },
        parts: [],
      },
    }, { epoch: "test", seq: 1 });
    f.reply(
      {
        ...page(),
        load: { ...load, revision: 2, state: "complete" },
      } as MessagePage,
    );
    await f.settle();
    assertEquals(f.owner.state.content.messages.length, 11);
    assertEquals(f.owner.state.clock?.seq, 1);
    assertEquals(f.owner.latestPrompt()?.id, "live");
    assertEquals(f.owner.transcript?.state.load?.state, "complete");
  } finally {
    f.stop();
  }
});

Deno.test("selected replay accepts sealed catchup once, rejects gaps and bounds held-baseline overflow", async () => {
  const f = fixture();
  try {
    f.owner.open({ sidecarId: "server", sessionID: "opcv1-s" });
    const added = { ...page().items[0], id: "new" };
    f.event({ op: "message.upsert", message: added }, { ...clock, seq: 1 });
    f.reply({
      ...page(),
      clock: { ...clock, seq: 1 },
      catchup: [{
        clock: { ...clock, seq: 1 },
        event: { op: "message.upsert", message: added },
      }],
    });
    await f.settle();
    assertEquals(
      f.owner.state.content.messages.filter((m) => m.id === "new").length,
      1,
    );
    f.event({ op: "message.remove", messageID: "new" }, { ...clock, seq: 1 });
    assert(f.owner.state.content.messages.some((m) => m.id === "new"));
    f.event({ op: "message.remove", messageID: "new" }, { ...clock, seq: 3 });
    assertEquals(f.owner.state.continuity, "missing");
    assert(f.owner.state.content.messages.some((m) => m.id === "new"));
  } finally {
    f.stop();
  }
});

Deno.test("held baselines discard overflowing logs, recover final source, and ignore buffered duplicates", async () => {
  const f = fixture();
  try {
    f.owner.open({ sidecarId: "server", sessionID: "opcv1-s" });
    for (let seq = 1; seq <= 10000; seq++) {
      f.event({
        op: "session.error",
        error: seq === 1 ? "界".repeat(1500000) : String(seq),
      }, { ...clock, seq });
    }
    assertEquals(f.owner.state.continuity, "missing");
    assertEquals(f.owner.state.content.messages, []);
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      1,
    );
    const work = f.owner.refetch();
    assertEquals(
      f.owner.state.continuity,
      "missing",
      "a replacement request is not restored continuity",
    );
    f.frames.splice(0, 1);
    f.reply({
      ...page(),
      clock: { ...clock, seq: 10000 },
      from: { ...clock, seq: 10000 },
    });
    await work;
    assertEquals(f.owner.state.continuity, "ready");
    assertEquals(f.owner.state.content.messages.length, 10);
    const refresh = f.owner.refetch();
    f.event({ op: "session.error", error: "final source" }, {
      ...clock,
      seq: 10001,
    });
    f.event({ op: "session.error", error: "final source" }, {
      ...clock,
      seq: 10001,
    });
    f.reply({
      ...page(),
      clock: { ...clock, seq: 10000 },
      from: { ...clock, seq: 10000 },
    });
    await refresh;
    assertEquals(f.owner.state.continuity, "ready");
    assertEquals(f.owner.state.content.error, "final source");
  } finally {
    f.stop();
  }
});

Deno.test("post-seal buffered user headers advance composer metadata with the installed body", async () => {
  const f = fixture();
  try {
    f.owner.open({ sidecarId: "server", sessionID: "opcv1-s" });
    const latest = {
      ...page().items[0],
      id: "new-prompt",
      agent: "build",
      model: { provider: "new", model: "model" },
      variant: "high",
    };
    f.event({ op: "message.upsert", message: latest }, { ...clock, seq: 1 });
    f.reply(page());
    await f.settle();
    assertEquals(f.owner.latestPrompt(), {
      id: latest.id,
      agent: latest.agent,
      model: latest.model,
      variant: latest.variant,
    });
  } finally {
    f.stop();
  }
});
