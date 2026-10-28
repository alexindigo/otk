// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createSession, SidecarConnection } from "../mod.ts";
import type { ContentClock, ContentOp, MessagePage } from "@otk/protocol";

const policy = { replayops: 2, replaybytes: 4096, retryms: 1000 };
const clock = { epoch: "test", seq: 0 };
const page = (older: string | null = null): MessagePage => ({
  sessionID: "opcv1-s",
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
function fixture() {
  const frames: { id: string; method: string; params: unknown }[] = [];
  const connection = new SidecarConnection("http://fixture.invalid", {
    status() {},
    frame() {},
  }, { messages: policy });
  connection.send = (frame) => {
    if (frame.t === "rpc") frames.push(frame);
  };
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
    connection.rpc.receive({ t: "rpc.result", id: frame.id, ok: true, result });
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
