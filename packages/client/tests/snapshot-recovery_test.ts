// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type {
  ClientFrame,
  ContentOp,
  ContentSession,
  Message,
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
  const frames: Extract<ClientFrame, { t: "rpc" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  });
  connection.send = (frame) => {
    if (frame.t === "rpc") frames.push(frame);
  };
  connection.supports = (capability) =>
    capability === "permissions" || capability === "questions";
  connection.subscribe = () => {};
  const owner = createSession(() => connection, () => undefined);
  const reply = (method: string, result: unknown, error?: string) => {
    const at = frames.findIndex((frame) => frame.method === method);
    assert(at >= 0, `missing request: ${method}`);
    const { id } = frames.splice(at, 1)[0];
    connection.rpc.receive(
      error
        ? {
          t: "rpc.result",
          id,
          ok: false,
          error: { code: "fixture", message: error },
        }
        : { t: "rpc.result", id, ok: true, result },
    );
  };
  const event = (event: ContentOp) =>
    owner.receive("server", { t: "content", sessionID: "s", event });
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

Deno.test("essential transcript publishes independently of failed or held attention and sibling resources", async () => {
  const f = fixture();
  try {
    f.reply("session.get", info);
    f.reply("session.messages", [message]);
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
    await f.until(() => !!f.owner.state.error?.includes("siblings offline"));
    assertEquals(
      f.owner.state.content.questions.map((question) => question.id),
      ["live"],
    );
    assertEquals(f.owner.state.content.messages.map((item) => item.id), ["m"]);
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
    f.reply("session.get", undefined, "initial unavailable");
    await f.until(() => !f.owner.state.loading && !!f.owner.state.error);
    const retry = f.owner.refetch();
    // Retired RPC requests are aborted; take only the newest still-pending IDs.
    f.frames.splice(0, f.frames.length - 4);
    f.reply("session.get", { ...info, parentID: undefined });
    f.reply("session.messages", []);
    f.reply("permission.list", []);
    f.reply("question.list", []);
    await retry;
    assertEquals(f.owner.state.content.messages.map((item) => item.id), ["m"]);
    assertEquals(f.owner.state.content.messages[0].parts[0].id, "text");
  } finally {
    f.stop();
  }
});

Deno.test("failed replacement snapshots replay into last-good content and retire superseded paging", async () => {
  const f = fixture();
  try {
    f.reply("session.get", { ...info, parentID: undefined });
    f.reply(
      "session.messages",
      Array.from({ length: 100 }, (_, i) => ({ ...message, id: `m${i}` })),
    );
    f.reply("permission.list", []);
    f.reply("question.list", []);
    await f.until(() => !f.owner.state.loading);
    const page = f.owner.older();
    assert(f.owner.state.paging);
    const refresh = f.owner.refetch();
    f.event({ op: "message.upsert", message });
    f.frames.splice(0, f.frames.length - 4);
    f.reply("session.get", undefined, "replacement unavailable");
    await refresh;
    await page;
    assertEquals(f.owner.state.paging, false);
    assertEquals(f.owner.state.content.messages.length, 101);
    assert(f.owner.state.content.messages.some((item) => item.id === "m"));
  } finally {
    f.stop();
  }
});
