// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createDrafts,
  createSessionRevert,
  createState,
  emptyContent,
  type SessionState,
} from "@otk/client";
import type { ContentSession, Message, RevertInfo } from "@otk/protocol";

const prompt = (id: string): Message => ({
  id,
  sessionID: "a",
  role: "user",
  time: { created: 1 },
  parts: [],
});
const record = (id = "p"): RevertInfo => ({
  boundaryID: id,
  messageIDs: [id, "reply"],
  files: [],
  prompt: {
    input: "Reverted prompt",
    mode: "normal",
    time: 1,
    parts: [{ kind: "text", text: "Reverted prompt" }],
  },
});
function fixture() {
  const session = createState<SessionState>({
    selection: { sidecarId: "local", sessionID: "a" },
    content: { ...emptyContent(), messages: [prompt("p"), prompt("reply")] },
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
    clock: { epoch: "initial", seq: 0 },
  });
  const drafts = createDrafts();
  drafts.writer("local/a")((d) => ({ ...d, input: "Prior unsent draft" }));
  const events: string[] = [], values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const saved = Promise.withResolvers<void>();
  const copies: import("@otk/client").BranchHistoryState = {
    branches: [],
    pending: false,
  };
  let refused = false;
  const base: ContentSession = {
    id: "a",
    title: "A",
    directory: "/repo",
    projectID: "project",
    archived: false,
    time: { created: 1, updated: 1 },
  };
  const create = () =>
    createSessionRevert({
      session,
      drafts,
      storage,
      status: { working: () => false, subscribe: () => () => {} },
      branchHistory: {
        state: copies,
        prepare: (_target, boundary, staged) => {
          events.push("capture");
          return saved.promise.then(() => {
            copies.branches = [{
              id: "copy",
              boundary,
              created: 1,
              session: { ...base, revert: staged },
              messages: (staged?.messageIDs ?? []).map(prompt),
              turns: {},
              prompts: [],
              drafts: [],
              pending: true,
              bytes: 1,
            }];
          });
        },
      },
      actions: {
        abort: () => Promise.resolve(),
        revert: (_target, id) => {
          events.push("stage");
          return refused
            ? Promise.reject(new Error("refused"))
            : Promise.resolve({ ...base, revert: record(id) });
        },
        restore: () => {
          events.push("restore");
          return Promise.resolve(base);
        },
      },
    });
  const publish = (revert?: RevertInfo) =>
    session.update((s) => {
      s.clock = { epoch: "next-" + (revert?.boundaryID ?? "clear"), seq: 0 };
      s.content.revert = revert ?? null;
      s.content.messages = revert ? [] : [prompt("p"), prompt("reply")];
    });
  return {
    session,
    drafts,
    events,
    saved,
    copies,
    create,
    publish,
    refused: () => {
      refused = true;
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

Deno.test("revert flow confirms without sending, refills every stage, then captures only after publication", async () => {
  const f = fixture(), owner = f.create();
  await owner.revertTo("p");
  assertEquals(owner.state.phase, "confirming");
  assertEquals(owner.state.messages?.map((m) => m.id), ["p", "reply"]);
  assertEquals(f.events, []);
  const confirming = owner.confirm();
  await settle();
  const readiness = owner.ready({ sidecarId: "local", sessionID: "a" });
  let ready = false;
  void readiness?.then(() => ready = true);
  await settle();
  assertEquals(ready, false);
  assertEquals(
    owner.ready({ sidecarId: "local", sessionID: "other" }),
    undefined,
  );
  assertEquals(f.events, ["stage"]);
  assertEquals(f.drafts.current("local/a").input, "Prior unsent draft");
  f.publish(record());
  await confirming;
  await readiness;
  assertEquals(ready, true);
  assertEquals(owner.ready({ sidecarId: "local", sessionID: "a" }), undefined);
  assertEquals(f.events, ["stage", "capture"]);
  assertEquals(f.drafts.current("local/a").input, "Reverted prompt");
  assertEquals(
    f.drafts.reverts.get("local/a")?.before.input,
    "Prior unsent draft",
  );
  f.saved.resolve();
  await settle();
  assertEquals(owner.state.phase, "saved");
  owner.dispose();
});

Deno.test("failed staging never replaces the prior draft", async () => {
  const f = fixture(), owner = f.create();
  f.refused();
  await owner.revertTo("p");
  await owner.confirm();
  assertEquals(owner.state.phase, "failed");
  assertEquals(f.drafts.current("local/a").input, "Prior unsent draft");
  owner.dispose();
});

Deno.test("a changed identity preview needs confirmation again and Cancel sends nothing", async () => {
  const f = fixture(), owner = f.create();
  await owner.revertTo("p");
  f.session.update((s) => {
    s.content.messages = [...s.content.messages, {
      ...prompt("later"),
      time: { created: 2 },
    }];
  });
  await owner.confirm();
  assertEquals(f.events, []);
  assertEquals(owner.state.messages?.map((m) => m.id), ["p", "reply", "later"]);
  owner.cancel();
  assertEquals(owner.state.phase, "idle");
  assertEquals(f.drafts.current("local/a").input, "Prior unsent draft");
  owner.dispose();
});

Deno.test("deleting a copy does not suppress preservation for a different locally staged boundary", async () => {
  const f = fixture(), owner = f.create();
  f.publish(record());
  f.saved.resolve();
  await settle();
  assertEquals(owner.state.phase, "saved");
  f.copies.branches = [];
  f.session.update(() => {});
  assertEquals(owner.state.copyRemoved, true);
  f.session.update((state) => {
    state.content.messages = [prompt("new")];
  });
  try {
    await owner.revertTo("new");
    const confirming = owner.confirm();
    await settle();
    f.publish(record("new"));
    await confirming;
    await settle();
    assertEquals(f.events, ["capture", "stage", "capture"]);
    assertEquals(owner.state.copyRemoved, undefined);
    assertEquals(f.copies.branches[0].boundary, "new");
  } finally {
    owner.dispose();
  }
});

Deno.test("a failed earlier-branch save never clears the refilled composer", async () => {
  const f = fixture(), owner = f.create();
  await owner.revertTo("p");
  const staged = owner.confirm();
  await settle();
  f.publish(record());
  await staged;
  f.saved.reject(new Error("storage unavailable"));
  await settle();
  assertEquals(owner.state.phase, "failed");
  assertEquals(f.drafts.current("local/a").input, "Reverted prompt");
  owner.dispose();
});

for (const succeeds of [true, false]) {
  Deno.test(`archive completion (${succeeds}) cannot replace an active Restore phase`, async () => {
    const f = fixture(), owner = f.create();
    f.publish(record());
    await settle();
    const restoring = owner.restore();
    await settle();
    assertEquals(owner.state.phase, "restoring");
    if (succeeds) f.saved.resolve();
    else f.saved.reject(new Error("storage unavailable"));
    await settle();
    assertEquals(owner.state.pending, "restore");
    assertEquals(owner.state.phase, "restoring");
    f.publish();
    await restoring;
    assertEquals(owner.state.phase, "idle");
    owner.dispose();
  });
}

Deno.test("external reverts share persistent dismissal; a new boundary shows normally and native clear removes it", async () => {
  const f = fixture(), owner = f.create();
  f.saved.resolve();
  f.publish(record());
  await settle();
  assertEquals(owner.state.record?.boundaryID, "p");
  owner.dismiss();
  assertEquals(owner.state.dismissed, true);
  owner.dispose();
  const reloaded = f.create();
  await settle();
  assertEquals(reloaded.state.dismissed, true);
  f.publish(record("different"));
  await settle();
  assertEquals(reloaded.state.dismissed, false);
  f.publish();
  assertEquals(reloaded.state.record, undefined);
  f.publish(record("committed"));
  await settle();
  reloaded.dismiss();
  f.session.update((s) => {
    s.content.revert = null;
    s.content.messages = [prompt("new branch")];
    s.clock = { epoch: "native-commit", seq: 0 };
  });
  assertEquals(reloaded.state.record, undefined);
  assertEquals(f.events.includes("stage"), false);
  assertEquals(f.events.includes("restore"), false);
  reloaded.dispose();
});
