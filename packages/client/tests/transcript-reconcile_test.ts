// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type {
  AssistantMessage,
  ClientFrame,
  ClockedContent,
  Message,
  MessagePage,
  Part,
} from "@otk/protocol";
import { SidecarConnection } from "../connection.ts";
import { createTranscripts } from "../transcripts.ts";
import {
  connectRequests,
  fixtureFailure,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

const target = { sidecarId: "server", sessionID: "a" };
const policy = { ...fixtureMessagePolicy, bridgepages: 2 };
const messages = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i),
    sessionID: "a",
    role: "user",
    time: { created: i },
    parts: [],
  }));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const requests: Extract<ClientFrame, { t: "request" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: policy });
  Object.defineProperty(connection, "connected", { get: () => true });
  connection.send = (frame) => {
    if (frame.t === "request" && frame.method === "session.messages") {
      requests.push(frame);
    }
  };
  connection.subscribe = () => {};
  connectRequests(connection.rpc);
  const owner = createTranscripts({
    connection: () => connection,
    entry: () => undefined,
  });
  owner.setDemand({
    scope: { sidecarId: "server", directory: "/a" },
    sessions: [target],
    selected: target,
  });
  const transcript = owner.get(target)!;
  const next = () => {
    const request = requests.shift();
    assert(request, "expected a queued history boundary");
    return request;
  };
  const reply = async (count: number, change?: (page: MessagePage) => void) => {
    await flush();
    const request = next();
    const page = fixturePage(
      "a",
      messages(count),
      (request.params as { before?: string }).before,
    );
    change?.(page);
    replyRequest(connection.rpc, request, page);
    await flush();
    return request;
  };
  return {
    owner,
    transcript,
    requests,
    next,
    reply,
    connection,
    stop() {
      owner.stop();
      connection.rpc.close();
    },
  };
}

Deno.test("a failed bounded bridge keeps both ranges and retries the same frontier", async () => {
  const f = fixture();
  try {
    await f.reply(40);
    await f.reply(40);
    const a = f.transcript, retained = a.state.messagesByID["25"];
    const snapshots: { ids: string[]; gap?: string; retained?: Message }[] = [];
    const release = a.subscribe((state) =>
      snapshots.push({
        ids: [...state.messageIDs],
        gap: state.gaps[0]?.state,
        retained: state.messagesByID["25"],
      })
    );
    const newest = a.refetch();
    const request = await f.reply(90);
    assertEquals(
      (request.params as { retryRecovery?: boolean }).retryRecovery,
      true,
    );
    await newest;
    assert(
      snapshots.some(({ ids, gap }) => ids.includes("89") && gap === "idle"),
    );
    const bridge = a.bridge();
    assertStrictEquals(a.bridge(), bridge);
    for (const before of [80, 70]) {
      assertEquals(
        ((await f.reply(90)).params as { before?: string }).before,
        `fixture:${before}`,
      );
    }
    await bridge;
    assertEquals(
      f.requests.length,
      0,
      "no automatic batch beyond the configured limit",
    );
    assertEquals(a.state.gaps[0].state, "idle");
    const key = a.state.gaps[0].key;
    const failed = a.bridge(key);
    replyRequest(f.connection.rpc, f.next(), undefined, fixtureFailure());
    await failed;
    assertEquals(a.state.gaps[0].state, "failed");
    assert(a.state.gaps[0].failure);
    assert(snapshots.every(({ retained: body }) => body === retained));
    release();
  } finally {
    f.stop();
  }
});

Deno.test("catchup removes a retained row and deduplicates an upsert in the page", async () => {
  const f = fixture();
  try {
    await f.reply(40);
    await f.reply(40);
    const a = f.transcript, unchanged = a.state.messagesByID["25"];
    const observed: string[][] = [];
    const release = a.subscribe((state) =>
      observed.push([...state.messageIDs])
    );
    const work = a.refetch();
    await f.reply(40, (page) => {
      page.clock = { epoch: "fixture", seq: 2 };
      page.catchup = [
        {
          clock: { epoch: "fixture", seq: 1 },
          event: { op: "message.upsert", message: page.items[0] },
        },
        { clock: page.clock, event: { op: "message.remove", messageID: "24" } },
      ];
    });
    await work;
    release();
    assertEquals(a.state.messagesByID["24"], undefined);
    assertStrictEquals(a.state.messagesByID["25"], unchanged);
    assert(
      observed.every((ids) =>
        ids.includes("25") && ids.filter((id) => id === "30").length === 1
      ),
    );
  } finally {
    f.stop();
  }
});

Deno.test("older-page header catchup preserves a retained completed Work tool at the live clock", async () => {
  const f = fixture();
  try {
    await f.reply(40);
    await f.reply(40);
    const a = f.transcript;
    const receive = (seq: number, event: ClockedContent["event"]) => {
      const clock = { epoch: "fixture", seq };
      f.owner.receive("server", {
        t: "content",
        sessionID: "a",
        clock,
        event,
      }, true);
      return { clock, event };
    };
    const step: AssistantMessage = {
      id: "40",
      sessionID: "a",
      role: "assistant",
      replyTo: "39",
      model: { provider: "test", model: "test" },
      agent: "build",
      time: { created: 40 },
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    };
    const work: Part = {
      kind: "tool",
      id: "work-part",
      call: {
        tool: "external",
        name: "Work",
        callID: "work-call",
        status: "completed",
        summary: "Check the fixture",
        output: "Fixture checked",
        time: { start: 41, end: 42 },
      },
    };
    receive(1, { op: "message.upsert", message: step });
    const { clock: from } = receive(2, {
      op: "part.upsert",
      messageID: step.id,
      part: work,
    });

    assertEquals(a.state.messagesByID["10"], undefined);
    const older = a.older();
    await flush();
    const request = f.next();
    const before = (request.params as { before?: string }).before;
    assertEquals(before, "fixture:20");
    const page = fixturePage("a", messages(40), before, undefined, from);
    assert(!page.items.some(({ id }) => id === step.id));

    // Both events arrive live before the older page returns them in catchup.
    const header = { ...step, time: { created: 40, completed: 43 } };
    const text: Part = {
      kind: "text",
      id: "late-text",
      synthetic: false,
      blocks: [{ b: "paragraph", inline: [{ i: "text", text: "Checked." }] }],
    };
    const tail = {
      ...header,
      id: "41",
      time: { created: 44, completed: 45 },
      parts: [text],
    };
    const finished = receive(3, { op: "message.upsert", message: header });
    const appended = receive(4, { op: "message.upsert", message: tail });
    page.clock = appended.clock;
    page.catchup = [finished, appended];
    const reply = () => a.state.repliesByID["reply:39"];
    assertEquals(a.state.clock, page.clock);
    assertEquals(a.state.messagesByID[step.id].parts, [work]);
    assertEquals(reply().message.parts, [work, text]);

    replyRequest(f.connection.rpc, request, page);
    await older;
    assert(a.state.messagesByID["10"], "older history must load");
    assertEquals(a.state.olderCursor, "fixture:10");
    assertEquals(
      a.state.messagesByID[step.id].parts,
      [work],
      "canonical source",
    );
    assertEquals(reply().message.parts, [work, text], "grouped reply");
  } finally {
    f.stop();
  }
});

Deno.test("initial invalidation fences old authority and later invalidation retains the acquired history", async () => {
  const f = fixture();
  try {
    const a = f.transcript;
    const invalidate = (revision: number) =>
      f.owner.receive("server", {
        t: "transcript.invalidated",
        sessionID: "a",
        version: { generation: 0, revision },
      }, true);
    invalidate(1);
    await f.reply(40);
    assertEquals(a.state.messageIDs, []);
    for (let i = 0; i < 2; i++) {
      await f.reply(40, (page) => {
        page.version.revision = 1;
      });
    }
    const retained = a.state.messagesByID["25"];
    assert(retained);
    const observed: Message[] = [];
    const release = a.subscribe((state) =>
      observed.push(state.messagesByID["25"])
    );
    invalidate(2);
    await f.reply(41, (page) => {
      page.version.revision = 2;
    });
    assertEquals(a.state.version?.revision, 2);
    assert(a.state.messagesByID["40"]);
    assert(
      observed.length > 0 && observed.every((message) => message === retained),
    );
    const retry = a.refetch();
    replyRequest(f.connection.rpc, f.next(), undefined, fixtureFailure());
    await retry;
    assert(a.state.pageError);
    assertStrictEquals(a.state.messagesByID["25"], retained);
    release();
  } finally {
    f.stop();
  }
});
