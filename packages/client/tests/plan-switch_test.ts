// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type {
  AgentOption,
  ClientFrame,
  ContentOp,
  ContentSession,
  Message,
} from "@otk/protocol";
import {
  createComposerSelection,
  createDrafts,
  createSession,
  SidecarConnection,
  type ToolPart,
} from "../mod.ts";

const target = { sidecarId: "server", sessionID: "s" };
const info: ContentSession = {
  id: "s",
  directory: "/project",
  title: "Session",
  projectID: "project",
  time: { created: 1, updated: 1 },
  archived: false,
};
const tool = (
  id: string,
  name = "plan_exit",
  status: ToolPart["call"]["status"] = "completed",
): ToolPart => ({
  kind: "tool",
  id,
  call: {
    tool: "external",
    name,
    summary: name,
    callID: id,
    status,
    time: {},
    awaitingPermission: false,
  },
});
const message = (id = "m", parts: ToolPart[] = []): Message => ({
  id,
  sessionID: "s",
  role: "user",
  time: { created: 1 },
  parts,
});
const agents: AgentOption[] = [
  {
    name: "build",
    model: { provider: "fake", model: "build-model" },
    variant: "high",
  },
  {
    name: "plan",
    model: { provider: "fake", model: "plan-model" },
    variant: "low",
  },
];
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture(loadAgents = () => Promise.resolve(agents)) {
  const frames: Extract<ClientFrame, { t: "rpc" }>[] = [];
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  });
  connection.send = (frame) => {
    if (frame.t === "rpc") frames.push(frame);
  };
  connection.supports = () => false;
  connection.subscribe = () => {};
  const session = createSession(() => connection, () => undefined);
  const drafts = createDrafts(), change = drafts.writer("server/s");
  let mutations = 0;
  const stopDrafts = drafts.subscribe(() => mutations++);
  const answer = (method: string, result: unknown) => {
    const at = frames.findIndex((frame) => frame.method === method);
    assert(at >= 0, method);
    const frame = frames.splice(at, 1)[0];
    connection.rpc.receive({ t: "rpc.result", id: frame.id, ok: true, result });
  };
  const receive = (event: ContentOp, sidecarId = "server", sessionID = "s") =>
    session.receive(sidecarId, { t: "content", sessionID, event });
  const part = (part: ToolPart, sidecarId?: string, sessionID?: string) =>
    receive({ op: "part.upsert", messageID: "m", part }, sidecarId, sessionID);
  const snapshot = async (messages = [message()]) => {
    answer("session.get", info);
    answer("session.messages", messages);
    await settle();
  };
  const composer = () => {
    const owner = createComposerSelection({
      draft: () => drafts.get("server/s"),
      change,
      context: () => undefined,
      connection: () => ({
        key: "socket",
        connected: true,
        agents: true,
        models: false,
      }),
      load: {
        agents: loadAgents,
        models: () => Promise.resolve({ providers: [] }),
      },
      prefs: {
        get: () => ({ "models.favourite": [], "models.recent": [] }),
        set: () => Promise.resolve(),
      },
      onToolCompleted: (listener) => session.onToolCompleted(target, listener),
    });
    owner.connect();
    return owner;
  };
  session.open(target);
  return {
    session,
    change,
    answer,
    snapshot,
    part,
    receive,
    composer,
    draft: () => drafts.get("server/s"),
    mutations: () => mutations,
    stop() {
      stopDrafts();
      session.stop();
      connection.stop();
    },
  };
}

Deno.test("plan tools switch only on live completed parts in the current session and apply the manual agent configuration", async () => {
  const f = fixture(), owner = f.composer();
  try {
    await f.snapshot();
    await owner.ready();
    f.change((draft) => ({ ...draft, input: "unsent text", agent: "plan" }));
    const before = f.mutations();
    for (const status of ["pending", "running", "error", "denied"] as const) {
      f.part(tool("exit", "plan_exit", status));
    }
    f.part(tool("other", "unrelated"));
    f.part(tool("foreign-server"), "other");
    f.part(tool("foreign-session"), "server", "child");
    await settle();
    assertEquals(f.mutations(), before);
    f.part(tool("exit"));
    await settle();
    assertEquals(f.draft().agent, "build");
    assertEquals(f.draft().model, agents[0].model);
    assertEquals(f.draft().variant, "high");
    assertEquals(f.draft().input, "unsent text");
    f.part(tool("enter", "plan_enter"));
    await settle();
    assertEquals(f.draft().agent, "plan");
    assertEquals(f.draft().model, agents[1].model);
    assertEquals(f.draft().variant, "low");
  } finally {
    owner.dispose();
    f.stop();
  }
});

Deno.test("plan completion IDs cannot replay over a newer manual choice, including reconnect snapshots and history paging", async () => {
  const f = fixture(), owner = f.composer();
  try {
    await f.snapshot(Array.from({ length: 100 }, (_, i) => message(String(i))));
    f.receive({ op: "message.upsert", message: message() });
    await owner.ready();
    f.part(tool("once"));
    await settle();
    owner.chooseAgent("plan");
    const before = f.mutations();
    f.part(tool("once"));
    f.part(tool("once", "plan_exit", "running"));
    f.part(tool("once"));
    f.session.receive("server", { t: "resync", sessionIDs: "all" });
    await f.snapshot(
      Array.from(
        { length: 100 },
        (_, i) =>
          message(
            String(i),
            i ? [] : [tool("once"), tool("reconnect-history")],
          ),
      ),
    );
    f.part(tool("once"));
    f.part(tool("reconnect-history"));
    const page = f.session.older();
    f.answer("session.messages", [message("older", [tool("paged")])]);
    await page;
    f.part(tool("paged"));
    await settle();
    assertEquals(f.draft().agent, "plan");
    assertEquals(f.mutations(), before);
  } finally {
    owner.dispose();
    f.stop();
  }
});

Deno.test("opening and reopening completed history is silent but completions received during initial loading reach a late composer", async () => {
  const f = fixture();
  let owner: ReturnType<typeof f.composer> | undefined;
  try {
    f.receive({ op: "message.upsert", message: message() });
    f.part(tool("live-during-open", "plan_enter"));
    await f.snapshot([message("history", [tool("already-completed")])]);
    owner = f.composer();
    await owner.ready();
    await settle();
    assertEquals(f.draft().agent, "plan");
    owner.dispose();
    f.session.open();
    f.session.open(target);
    await f.snapshot([
      message("m", [
        tool("live-during-open", "plan_enter"),
        tool("already-completed"),
      ]),
    ]);
    f.change((draft) => ({ ...draft, agent: "build" }));
    const before = f.mutations();
    owner = f.composer();
    await owner.ready();
    f.part(tool("live-during-open", "plan_enter"));
    f.part(tool("already-completed"));
    await settle();
    assertEquals(f.mutations(), before);
    assertEquals(f.draft().agent, "build");
  } finally {
    owner?.dispose();
    f.stop();
  }
});

Deno.test("plan auto-switch waits for primary agents, ignores a missing agent and disposal cancels a pending switch", async () => {
  const pending = Promise.withResolvers<AgentOption[]>();
  const f = fixture(() => pending.promise), owner = f.composer();
  try {
    await f.snapshot();
    f.change((draft) => ({ ...draft, agent: "plan" }));
    f.part(tool("missing-build"));
    pending.resolve([agents[1]]);
    await owner.ready();
    await settle();
    assertEquals(f.draft().agent, "plan");
    assertEquals(
      f.draft().model,
      undefined,
      "Missing primary agent changes nothing",
    );
  } finally {
    owner.dispose();
    f.stop();
  }
  const delayed = Promise.withResolvers<AgentOption[]>();
  const g = fixture(() => delayed.promise), disposed = g.composer();
  try {
    await g.snapshot();
    g.part(tool("late", "plan_enter"));
    disposed.dispose();
    delayed.resolve(agents);
    await settle();
    assertEquals(g.draft().agent, undefined);
    g.part(tool("after-dispose"));
    await settle();
    assertEquals(g.draft().agent, undefined);
  } finally {
    disposed.dispose();
    g.stop();
  }
});
