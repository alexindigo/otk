// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type {
  ClientFrame,
  ContentOp,
  Message,
  MessagePolicy,
  PermissionRequest,
  QuestionRequest,
} from "@otk/protocol";
import { createTranscripts, type TranscriptClock } from "../transcripts.ts";
import { SidecarConnection } from "../connection.ts";
import {
  connectRequests,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import { createState, type StateFactory } from "../state.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

function clock() {
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const value: TranscriptClock = {
    now: () => now,
    set: (run, ms) => {
      const id = ++serial;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => {
      timers.delete(id as number);
    },
  };
  return {
    value,
    get timers() {
      return timers.size;
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.at <= now);
        if (!due) return;
        timers.delete(due[0]);
        due[1].run();
      }
    },
  };
}
const target = (sessionID: string) => ({ sidecarId: "server", sessionID });
const scope = (directory = "/a") => ({ sidecarId: "server", directory });
const turns = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function fixture(policy?: MessagePolicy) {
  const time = clock();
  const requests: Extract<ClientFrame, { t: "request" }>[] = [];
  const subscriptions = new Set<string>();
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: policy });
  connection.send = (frame) => {
    if (frame.t === "request") requests.push(frame);
  };
  connectRequests(connection.rpc);
  connection.subscribe = (id, enabled) => {
    if (enabled) subscriptions.add(id);
    else subscriptions.delete(id);
  };
  const owner = createTranscripts({
    connection: () => connection,
    entry: () => undefined,
    clock: time.value,
  });
  const messages = (id: string, count = 80): Message[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `${id}-${String(i).padStart(3, "0")}`,
      sessionID: id,
      role: "user",
      time: { created: i },
      parts: [],
    }));
  const reply = async (index = 0, count = 80) => {
    const request = requests.splice(index, 1)[0];
    assert(request, "expected queued body read");
    const input = request.params as { sessionID: string; before?: string };
    replyRequest(
      connection.rpc,
      request,
      fixturePage(
        input.sessionID,
        messages(input.sessionID, count),
        input.before,
      ),
    );
    await turns();
  };
  return {
    owner,
    requests,
    reply,
    subscriptions,
    connection,
    time,
    messages,
    stop() {
      owner.stop();
      connection.rpc.close();
    },
  };
}
const policy = {
  ...fixtureMessagePolicy,
  coolms: 100,
  recoveryconcurrency: 2,
  recoverypending: 128,
  preloadms: 30,
  concurrency: 4,
};

Deno.test("late source events cannot backfill unrequested transcript history or retire its paging action", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    const resource = f.owner.get(target("a"))!;
    assertEquals(resource.state.messageIDs.length, 20);
    const history = f.messages("a")[55];
    const receive = (message: Message, seq: number) =>
      f.owner.receive("server", {
        t: "content",
        sessionID: "a",
        clock: { epoch: "fixture", seq },
        event: { op: "message.upsert", message },
      }, true);
    receive(history, 1);
    assertEquals(
      resource.state.messageIDs.length,
      20,
      "late history must await its requested page",
    );
    const known = {
      ...f.messages("a")[70],
      parts: [{
        kind: "text" as const,
        id: "updated",
        synthetic: false,
        blocks: [],
      }],
    };
    receive(known, 2);
    assertEquals(resource.state.messagesByID[known.id].parts, known.parts);
    const tail = { ...f.messages("a")[79], id: "a-080", time: { created: 80 } };
    receive(tail, 3);
    assertEquals(
      resource.state.messageIDs.length,
      21,
      "new live tail still advances after ignored source clocks",
    );
    const older = resource.older();
    const request = f.requests.shift()!;
    const page = fixturePage(
      "a",
      f.messages("a"),
      (request.params as { before?: string }).before,
    );
    replyRequest(f.connection.rpc, request, {
      ...page,
      from: { epoch: "fixture", seq: 3 },
      clock: { epoch: "fixture", seq: 4 },
      catchup: [{
        clock: { epoch: "fixture", seq: 4 },
        event: { op: "message.upsert", message: f.messages("a")[0] },
      }],
    });
    await turns();
    await older;
    assert(
      resource.state.messagesByID[history.id],
      "explicit paging still acquires the old source identity",
    );
    assertEquals(
      resource.state.messagesByID["a-000"],
      undefined,
      "older-page catchup must respect the same acquired-history boundary",
    );
  } finally {
    f.stop();
  }
});

Deno.test("warm transcripts reduce permission and question replacement before reselection without detail reads", async () => {
  const f = fixture(policy);
  f.connection.supports = (capability) =>
    capability === "permissions" || capability === "questions";
  try {
    f.owner.setDemand({ scope: scope(), sessions: [target("a")] });
    await f.reply();
    await f.reply();
    const a = f.owner.get(target("a"))!;
    assertEquals(a.state.temperature, "warm");
    const permission: PermissionRequest = {
      id: "old-permission",
      sessionID: "a",
      kind: "bash",
      title: "Old command",
      detail: { kind: "bash", command: "old command" },
      patterns: ["old command"],
      alwaysPatterns: [],
      time: 1,
    };
    const question: QuestionRequest = {
      id: "old-question",
      sessionID: "a",
      questions: [],
    };
    const deliver = (event: ContentOp) =>
      f.owner.receive("server", {
        t: "content",
        sessionID: "a",
        event,
      }, true);
    deliver({ op: "permission.upsert", request: permission });
    deliver({ op: "question.upsert", request: question });
    assertEquals(a.state.content.permissions, [permission]);
    assertEquals(a.state.content.questions, [question]);
    deliver({
      op: "permission.remove",
      requestID: permission.id,
      sessionID: "a",
    });
    deliver({ op: "question.remove", requestID: question.id, sessionID: "a" });
    const next = {
      ...permission,
      id: "new-permission",
      time: 2,
      detail: { kind: "bash" as const, command: "new command" },
    };
    deliver({ op: "permission.upsert", request: next });
    assertEquals(a.state.content.permissions, [next]);
    assertEquals(a.state.content.questions, []);
    assertEquals(
      f.requests,
      [],
      "Warm attention changes need no snapshot/detail read",
    );
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    assertEquals(
      a.state.content.permissions,
      [next],
      "Reselection cannot expose the previous approval target",
    );
  } finally {
    f.stop();
  }
});

Deno.test("transcript state publication never returns replacement state to a framework binding", () => {
  const f = fixture(policy), returned: unknown[] = [];
  const factory: StateFactory = <T extends object>(initial: T) => {
    const store = createState(initial);
    return {
      ...store,
      update(change: (draft: T) => void) {
        returned.push(change(store.state));
      },
    };
  };
  const owner = createTranscripts({
    connection: () => f.connection,
    entry: () => undefined,
    factory,
  });
  try {
    owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    assert(returned.length > 0);
    assertEquals(returned.every((value) => value === undefined), true);
  } finally {
    owner.stop();
    f.stop();
  }
});

Deno.test("transcripts wait for policy, admit selected first and share a four-read server ceiling across 251 sessions", async () => {
  const f = fixture();
  try {
    const sessions = Array.from({ length: 251 }, (_, i) => target(`s${i}`));
    f.owner.setDemand({ scope: scope(), sessions, selected: sessions[250] });
    assertEquals(f.requests.length, 0);
    f.owner.receive(
      "server",
      { t: "welcome", messages: policy } as never,
      true,
    );
    assertEquals(f.requests.length, 4);
    assertEquals(
      (f.requests[0].params as { sessionID: string }).sessionID,
      "s250",
    );
    assertEquals(f.owner.get(sessions[250])?.state.continuity, "loading");
    const resource = f.owner.get(sessions[250]);
    f.owner.preload(sessions[250], scope(), sessions);
    assertEquals(f.owner.get(sessions[250]), resource);
    await f.reply();
    assertEquals(resource?.state.messageIDs.length, 10);
    assertEquals(f.requests.length, 4);
    // Already-admitted native reads cannot be preempted; the next free slot belongs to selected reserve.
    await f.reply();
    assert(
      f.requests.some((r) =>
        (r.params as { before?: string }).before === "fixture:70"
      ),
    );
    await f.reply(
      f.requests.findIndex((r) =>
        (r.params as { sessionID: string; before?: string }).sessionID ===
          "s250"
      ),
    );
    assertEquals(resource?.state.messageIDs.length, 20);
    assertEquals(f.requests.length, 4);
  } finally {
    f.stop();
  }
});

Deno.test("temperature retains visited bodies, cools on one deadline timer, aborts queued work and fences late frames", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    const a = f.owner.get(target("a"))!;
    const previousContent = a.state.content;
    const paging = a.older();
    await f.reply();
    await paging;
    assertEquals(
      a.state.content === previousContent,
      false,
      "membership publication must invalidate a framework's borrowed content reference",
    );
    const retained = a.state.messagesByID["a-070"];
    f.owner.setDemand({
      scope: scope("/b"),
      sessions: [target("b")],
      selected: target("b"),
    });
    assertEquals(a.state.temperature, "warm");
    f.time.advance(99);
    assertEquals(a.state.messagesByID["a-070"], retained);
    assertEquals(f.time.timers, 1);
    f.time.advance(1);
    assertEquals(a.state.temperature, "cold");
    assertEquals(a.state.messageIDs, []);
    assertEquals(Object.keys(a.state.messagesByID), []);
    assertEquals(a.state.replyIDs, []);
    assertEquals(Object.keys(a.state.repliesByID), []);
    assertEquals(a.state.content.messages, []);
    assertEquals(a.state.recovering, []);
    assertEquals(a.state.pageLoading, false);
    assertEquals(
      f.connection.requests.operations("a").filter((operation) =>
        !["succeeded", "failed", "released"].includes(operation.state.phase)
      ).length,
      0,
    );
    assertEquals(f.subscriptions.has("a"), false);
    f.owner.stop();
    assertEquals(f.subscriptions.size, 0);
    assertEquals(f.time.timers, 0);
  } finally {
    f.stop();
  }
});

Deno.test("attention edges expire despite repeated metadata, never navigate or mark seen, and rehydrate only once", async () => {
  const f = fixture(policy);
  try {
    f.owner.preload(target("a"), scope(), [target("a"), target("b")]);
    await f.reply();
    await f.reply();
    await f.reply();
    await f.reply();
    assertEquals(f.owner.get(target("a"))?.state.temperature, "warm");
    assertEquals(f.requests.length, 0);
    f.time.advance(30);
    assertEquals(f.owner.get(target("a"))?.state.temperature, "cold");
    assertEquals(f.owner.get(target("a"))?.state.messageIDs, []);
    assertEquals(f.subscriptions.size, 0);
    assertEquals(f.time.timers, 0);
  } finally {
    f.stop();
  }
});

Deno.test("native-message viewport reserve refills at twenty and reverse motion reuses retained identities", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    const a = f.owner.get(target("a"))!;
    assertEquals(a.state.messageIDs.length, 20);
    a.viewport({ first: "a-070", last: "a-079" });
    await f.reply();
    await f.reply();
    assertEquals(a.state.messageIDs.length, 40);
    a.viewport({ first: "a-065", last: "a-074" });
    assertEquals(f.requests.length, 0);
    a.viewport({ first: "a-040", last: "a-049" });
    assertEquals(f.requests.length, 1);
  } finally {
    f.stop();
  }
});

Deno.test("warm return preserves current tail authority when only unused historical reserve was evicted", async () => {
  const f = fixture(policy);
  try {
    const demand = {
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    };
    f.owner.setDemand(demand);
    await f.reply();
    await f.reply();
    const a = f.owner.get(target("a"))!;
    a.viewport({ first: "a-070", last: "a-079" });
    await f.reply();
    await f.reply();
    assertEquals(a.state.messageIDs.length, 40);
    const tail = a.state.messagesByID["a-070"];
    a.viewport(undefined);
    f.owner.setDemand({ scope: scope("/b"), sessions: [] });
    assertEquals(a.state.messageIDs.length, 20);
    f.owner.setDemand(demand);
    assertEquals(
      f.requests,
      [],
      "An intact warm tail needs no newest-page repair",
    );
    assertEquals(a.state.messagesByID["a-070"], tail);
    assert(a.state.messagesByID["a-070"] === tail);
    const older = a.ensure("a-055");
    assertEquals(f.requests.length, 1);
    assertEquals(
      (f.requests[0].params as { before?: string }).before,
      "fixture:60",
    );
    await f.reply();
    await older;
    assert(a.state.messagesByID["a-070"] === tail);
    assert(a.state.messagesByID["a-055"]);
  } finally {
    f.stop();
  }
});

Deno.test("warm live tails stay bounded, visited pages survive until cooling and cold content cannot resurrect", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    const a = f.owner.get(target("a"))!;
    a.viewport({ first: "a-070", last: "a-079" });
    await f.reply();
    await f.reply();
    f.owner.setDemand({ scope: scope("/b"), sessions: [] });
    const event = (seq: number, event: ContentOp) =>
      f.owner.receive("server", {
        t: "content",
        sessionID: "a",
        event,
        clock: { epoch: "fixture", seq },
      }, true);
    for (let i = 0; i < 100; i++) {
      event(i + 1, {
        op: "message.upsert",
        message: f.messages("a", 200)[80 + i],
      });
    }
    assert(
      a.state.messageIDs.length <= 60,
      "only visited identities plus the live tail survive",
    );
    assert(a.state.messagesByID["a-070"]);
    f.time.advance(100);
    assertEquals(a.state.messageIDs, []);
    assertEquals(Object.keys(a.state.messagesByID), []);
    event(101, { op: "message.upsert", message: f.messages("a")[0] });
    assertEquals(a.state.messageIDs, []);
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    assertEquals(f.requests.length, 1);
    assertEquals(
      (f.requests[0].params as { before?: string }).before,
      undefined,
    );
  } finally {
    f.stop();
  }
});

Deno.test("scope interaction alone refreshes cooling and policy changes re-evaluate deadlines without replacing active work", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    const a = f.owner.get(target("a"))!;
    f.owner.setDemand({ scope: scope("/b"), sessions: [] });
    f.time.advance(60);
    f.owner.interact(scope());
    f.time.advance(60);
    assertEquals(a.state.temperature, "warm");
    f.owner.receive(
      "server",
      { t: "welcome", messages: { ...policy, coolms: 50 } } as never,
      true,
    );
    assertEquals(a.state.temperature, "cold");
    assertEquals(f.subscriptions.size, 0);
    f.owner.removeServer("server");
    assertEquals(f.owner.get(target("a")), undefined);
  } finally {
    f.stop();
  }
});

Deno.test("a bounded live tail reacquires its current native cursor before traversing a discarded warm gap", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    f.owner.setDemand({ scope: scope("/b"), sessions: [] });
    const messages = f.messages("a", 180);
    for (let i = 80; i < 180; i++) {
      f.owner.receive("server", {
        t: "content",
        sessionID: "a",
        event: { op: "message.upsert", message: messages[i] },
        clock: { epoch: "fixture", seq: i - 79 },
      }, true);
    }
    const a = f.owner.get(target("a"))!;
    assertEquals(a.state.messageIDs.length, 20);
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    assertEquals(
      a.state.continuity,
      "ready",
      "the current warm tail is already ready while continuation is repaired",
    );
    let settled = false;
    const work = a.older().then(() => {
      settled = true;
    });
    for (let i = 0; i < 4 && !settled; i++) await f.reply(0, 180);
    await work;
    assert(
      a.state.messagesByID["a-159"],
      "scrolling back reaches the immediate predecessor of the current tail",
    );
    assertEquals(
      !!a.state.messagesByID["a-050"],
      false,
      "a retired cursor cannot skip the discarded range",
    );
  } finally {
    f.stop();
  }
});

Deno.test("a warm tail admits a newly observed message within its retained chronological range", async () => {
  const f = fixture(policy);
  try {
    f.owner.setDemand({
      scope: scope(),
      sessions: [target("a")],
      selected: target("a"),
    });
    await f.reply();
    await f.reply();
    f.owner.setDemand({ scope: scope("/b"), sessions: [] });
    const message = {
      ...f.messages("a")[75],
      id: "a-075-late",
      time: { created: 75.5 },
    };
    f.owner.receive("server", {
      t: "content",
      sessionID: "a",
      event: { op: "message.upsert", message },
      clock: { epoch: "fixture", seq: 1 },
    }, true);
    assert(
      f.owner.get(target("a"))?.state.messagesByID[message.id],
      "late observation within the ready tail is still current content",
    );
    assertEquals(f.owner.get(target("a"))?.state.messageIDs.length, 20);
    assertEquals(
      f.owner.get(target("a"))?.latestPrompt()?.id,
      "a-079",
      "historical user headers cannot replace newer composer context",
    );
  } finally {
    f.stop();
  }
});
