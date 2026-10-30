// SPDX-License-Identifier: LGPL-3.0-only
import {
  connectRequests,
  fixtureFailure,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";
import { assert, assertEquals } from "@std/assert";
import type {
  ClientFrame,
  ContentOp,
  ContentSession,
  Message,
  ServerFrame,
} from "@otk/protocol";
import { createSession, SidecarConnection } from "../mod.ts";

const info: ContentSession = {
  id: "s",
  parentID: "parent",
  directory: "/project",
  projectID: "project",
  title: "Session",
  archived: false,
  time: { created: 1, updated: 1 },
};
const message: Message = {
  id: "m",
  sessionID: "s",
  role: "user",
  time: { created: 1 },
  parts: [],
};
function fixture() {
  const frames: Extract<ClientFrame, { t: "request" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.send = (frame) => {
    if (frame.t === "request") frames.push(frame);
  };
  connectRequests(connection.rpc);
  connection.supports = (capability) =>
    capability === "permissions" || capability === "questions";
  connection.subscribe = () => {};
  const owner = createSession(() => connection, () => undefined);
  const reply = (method: string, result: unknown, error?: string) => {
    const at = frames.findIndex((frame) => frame.method === method);
    assert(at >= 0, `missing request: ${method}`);
    const frame = frames.splice(at, 1)[0];
    replyRequest(
      connection.rpc,
      frame,
      result,
      error ? fixtureFailure("fixture") : undefined,
    );
  };
  let sequence = 0;
  const event = (event: ContentOp) =>
    owner.receive("server", {
      t: "content",
      sessionID: "s",
      event,
      clock: { epoch: "fixture", seq: ++sequence },
    });
  const until = (predicate: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      let release = () => {};
      const timer = setTimeout(() => {
        release();
        reject(new Error("snapshot consumer outcome missing"));
      }, 1000);
      const observe = () => {
        if (predicate()) {
          clearTimeout(timer);
          release();
          resolve();
        }
      };
      release = owner.subscribe(observe);
      observe();
    });
  owner.open({ sidecarId: "server", sessionID: "s" });
  return {
    owner,
    frames,
    reply,
    event,
    until,
    stop() {
      owner.stop();
      connection.rpc.close();
    },
  };
}

Deno.test("bootstrap completion and covered invalidations preserve acquired transcript authority", async () => {
  const f = fixture();
  const version = { generation: 2, revision: 3 };
  try {
    f.reply("session.messages", {
      ...fixturePage("s", [message], undefined, info),
      version,
    });
    await f.until(() => !f.owner.state.loading);
    const original = f.owner.state.content.messages[0];
    for (
      const frame of [
        { t: "bootstrap.complete" },
        { t: "transcript.invalidated", version, sessionID: "s" },
        {
          t: "transcript.invalidated",
          version: { generation: 1, revision: 99 },
        },
        {
          t: "transcript.invalidated",
          version: { generation: 2, revision: 2 },
          sessionID: "s",
        },
      ]
    ) f.owner.receive("server", frame as ServerFrame);
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      0,
    );
    assertEquals(f.owner.state.content.messages[0], original);
    assertEquals(f.owner.state.continuity, "ready");
  } finally {
    f.stop();
  }
});

Deno.test("newer invalidation refreshes stale authority once and never refetches another session", async () => {
  const f = fixture();
  try {
    f.reply("session.messages", {
      ...fixturePage("s", [message], undefined, info),
      version: { generation: 2, revision: 3 },
    });
    await f.until(() => !f.owner.state.loading);
    f.owner.receive(
      "server",
      {
        t: "transcript.invalidated",
        sessionID: "other",
        version: { generation: 2, revision: 4 },
      } as ServerFrame,
    );
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      0,
    );
    const changed = {
      t: "transcript.invalidated",
      sessionID: "s",
      version: { generation: 2, revision: 4 },
    } as ServerFrame;
    f.owner.receive("server", changed);
    f.owner.receive("server", changed);
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      1,
    );
    f.reply("session.messages", {
      ...fixturePage("s", [{ ...message, id: "new" }], undefined, info),
      version: { generation: 2, revision: 4 },
    });
    await f.until(() => !f.owner.state.loading);
    assertEquals(f.owner.state.content.messages.map((m) => m.id), ["new"]);
    f.owner.receive("server", changed);
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      0,
    );
  } finally {
    f.stop();
  }
});

Deno.test("invalidation fences a held old baseline but accepts a held page already at its version", async () => {
  for (const current of [false, true]) {
    const f = fixture();
    try {
      f.owner.receive(
        "server",
        {
          t: "transcript.invalidated",
          version: { generation: 3, revision: 0 },
        } as ServerFrame,
      );
      f.reply("session.messages", {
        ...fixturePage(
          "s",
          [{ ...message, id: current ? "current" : "retired" }],
          undefined,
          info,
        ),
        version: { generation: current ? 3 : 2, revision: 0 },
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      if (!current) {
        assertEquals(
          f.owner.state.content.messages.some((m) => m.id === "retired"),
          false,
        );
        assertEquals(
          f.frames.filter((frame) => frame.method === "session.messages")
            .length,
          1,
        );
        f.reply("session.messages", {
          ...fixturePage("s", [{ ...message, id: "current" }], undefined, info),
          version: { generation: 3, revision: 0 },
        });
      }
      await f.until(() => !f.owner.state.loading);
      assertEquals(f.owner.state.content.messages.map((m) => m.id), [
        "current",
      ]);
      assertEquals(
        f.frames.filter((frame) => frame.method === "session.messages").length,
        0,
      );
    } finally {
      f.stop();
    }
  }
});

Deno.test("bootstrap resync coalesces with the initial authoritative page instead of starting a duplicate baseline", async () => {
  const f = fixture();
  try {
    f.owner.receive("server", { t: "bootstrap.complete" });
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      1,
    );
    f.reply("session.messages", fixturePage("s", [message], undefined, info));
    await f.until(() => !f.owner.state.loading);
    assertEquals(f.owner.state.content.messages.map((message) => message.id), [
      "m",
    ]);
    assertEquals(f.owner.state.continuity, "ready");
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      0,
    );
  } finally {
    f.owner.stop();
  }
});

Deno.test("a resync-covered initial failure retries the new epoch immediately without concurrent baselines", async () => {
  const f = fixture();
  try {
    f.owner.receive("server", {
      t: "transcript.invalidated",
      version: { generation: 0, revision: 0 },
    });
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      1,
    );
    f.reply("session.messages", undefined, "retired provider epoch");
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assertEquals(
      f.frames.filter((frame) => frame.method === "session.messages").length,
      1,
      "The resync edge is a new checkpoint, not a timer-based retry",
    );
    f.reply(
      "session.messages",
      fixturePage("s", [message], undefined, info, {
        epoch: "current",
        seq: 0,
      }),
    );
    await f.until(() =>
      !f.owner.state.loading && f.owner.state.continuity === "ready"
    );
    assertEquals(f.owner.state.clock?.epoch, "current");
    assertEquals(f.owner.state.content.messages.map((message) => message.id), [
      "m",
    ]);
  } finally {
    f.owner.stop();
  }
});

Deno.test("essential transcript publishes independently of failed or held attention and sibling resources", async () => {
  const f = fixture();
  try {
    f.reply("session.messages", fixturePage("s", [message], undefined, info));
    f.reply("permission.list", undefined, "permissions offline");
    await f.until(() =>
      !f.owner.state.loading && f.owner.state.content.messages.length === 1
    );
    assertEquals(f.owner.state.info?.id, "s");
    f.event({
      op: "question.upsert",
      request: { id: "live", sessionID: "s", questions: [] },
    });
    f.reply("question.list", []);
    f.reply("session.children", undefined, "siblings offline");
    await f.until(() =>
      f.owner.state.error === "Could not finish this action. Try again"
    );
    assertEquals(
      f.owner.state.content.questions.map((question) => question.id),
      ["live"],
    );
    assertEquals(f.owner.state.content.messages.map((item) => item.id), ["m"]);
  } finally {
    f.stop();
  }
});

Deno.test("recovery state survives page installation, rejects stale generations and releases with authoritative source or cooling", async () => {
  const f = fixture();
  try {
    f.event({
      op: "stream.recovery",
      messageID: "m",
      partID: "p",
      generation: 2,
      state: "recovering",
    });
    f.reply("session.messages", fixturePage("s", [message], undefined, info));
    await f.until(() => !f.owner.state.loading);
    assertEquals(f.owner.transcript?.state.recovering.map((p) => p.partID), [
      "p",
    ]);
    f.event({
      op: "stream.recovery",
      messageID: "m",
      partID: "p",
      generation: 1,
      state: "ready",
    });
    assertEquals(f.owner.transcript?.state.recovering.length, 1);
    f.event({
      op: "stream.recovery",
      messageID: "m",
      partID: "p",
      generation: 2,
      state: "unavailable",
    });
    assertEquals(f.owner.state.content.recovering?.[0].state, "unavailable");
    f.event({
      op: "part.upsert",
      messageID: "m",
      part: {
        kind: "text",
        id: "p",
        synthetic: false,
        blocks: [],
        stream: {
          epoch: "fixture",
          generation: 4,
          version: 1,
          mode: "appendable",
        },
      },
    });
    assertEquals(f.owner.transcript?.state.recovering, []);
    f.event({
      op: "stream.recovery",
      messageID: "m",
      partID: "p",
      generation: 5,
      state: "recovering",
    });
    f.event({
      op: "part.upsert",
      messageID: "m",
      part: {
        kind: "text",
        id: "p",
        synthetic: false,
        blocks: [],
        stream: {
          epoch: "fixture",
          generation: 3,
          version: 1,
          mode: "appendable",
        },
      },
    });
    assertEquals(
      f.owner.transcript?.state.recovering.length,
      1,
      "a rejected old source cannot clear current recovery",
    );
    f.owner.transcript!.temperature("cold");
    assertEquals(f.owner.transcript?.state.recovering, []);
    assertEquals(f.owner.state.content.messages.length, 0);
  } finally {
    f.stop();
  }
});

Deno.test("failed initial snapshots retain live header and part across retry generations", async () => {
  const f = fixture();
  try {
    f.event({ op: "message.upsert", message });
    f.event({
      op: "part.upsert",
      messageID: "m",
      part: {
        kind: "text",
        id: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Retained live content" }],
        }],
      },
    });
    f.reply("session.messages", undefined, "initial unavailable");
    await f.until(() => !f.owner.state.loading && !!f.owner.state.error);
    const retry = f.owner.refetch();
    // Retired RPC requests are aborted; take only the newest still-pending IDs.
    f.frames.splice(0, f.frames.length - 3);
    f.reply(
      "session.messages",
      fixturePage(
        "s",
        [{
          ...message,
          parts: [{
            kind: "text",
            id: "text",
            synthetic: false,
            blocks: [{
              b: "paragraph",
              inline: [{ i: "text", text: "Retained live content" }],
            }],
          }],
        }],
        undefined,
        { ...info, parentID: undefined },
        { epoch: "fixture", seq: 2 },
      ),
    );
    f.reply("permission.list", []);
    f.reply("question.list", []);
    await retry;
    assertEquals(f.owner.state.content.messages.map((item) => item.id), ["m"]);
    assertEquals(f.owner.state.content.messages[0].parts[0].id, "text");
  } finally {
    f.stop();
  }
});

Deno.test("failed replacements retain last-good content, recover final source and retire superseded paging", async () => {
  const f = fixture();
  try {
    f.reply(
      "session.messages",
      fixturePage(
        "s",
        Array.from({ length: 100 }, (_, i) => ({ ...message, id: `m${i}` })),
        undefined,
        { ...info, parentID: undefined },
      ),
    );
    f.reply("permission.list", []);
    f.reply("question.list", []);
    await f.until(() => !f.owner.state.loading);
    const page = f.owner.older();
    assert(f.owner.state.paging);
    const refresh = f.owner.refetch();
    f.event({ op: "message.upsert", message });
    f.frames.splice(0, f.frames.length - 3);
    f.reply("session.messages", undefined, "replacement unavailable");
    await refresh;
    await page;
    assertEquals(f.owner.state.paging, false);
    assertEquals(f.owner.state.continuity, "missing");
    assertEquals(f.owner.state.content.messages.length, 10);
    const recovery = f.owner.refetch();
    f.frames.splice(0, f.frames.length - 3);
    f.reply(
      "session.messages",
      fixturePage("s", [message], undefined, { ...info, parentID: undefined }, {
        epoch: "fixture",
        seq: 1,
      }),
    );
    f.reply("permission.list", []);
    f.reply("question.list", []);
    await recovery;
    assert(f.owner.state.content.messages.some((item) => item.id === "m"));
  } finally {
    f.stop();
  }
});
