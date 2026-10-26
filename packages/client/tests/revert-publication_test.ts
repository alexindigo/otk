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
const message = (id: string): Message => ({
  id,
  sessionID: "a",
  role: "user",
  time: { created: 1 },
  parts: [],
});
const reverted = (id: string): RevertInfo => ({
  messageID: id,
  messageCount: id === "p1" ? 2 : 1,
  files: [],
  prompt: {
    input: id,
    mode: "normal",
    parts: [{ kind: "text", text: id }],
    time: 1,
  },
});
const info = (revert?: RevertInfo): ContentSession => ({
  id: "a",
  directory: "/project",
  projectID: "p",
  title: "A",
  time: { created: 1, updated: 1 },
  archived: false,
  revert,
});
function fixture() {
  const session = createState<SessionState>({
    selection: { sidecarId: "local", sessionID: "a" },
    content: { ...emptyContent(), messages: [message("p1"), message("p2")] },
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  });
  const calls: string[] = [], drafts = createDrafts();
  const owner = createSessionRevert({
    session,
    drafts,
    status: { working: () => false, subscribe: () => () => {} },
    actions: {
      abort: () => Promise.resolve(),
      revert: (_target, id) => {
        calls.push(id);
        return Promise.resolve(info(reverted(id)));
      },
      restore: () => {
        calls.push("restore");
        return Promise.resolve(info());
      },
    },
  });
  return { session, calls, drafts, owner };
}
const turn = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
Deno.test("undo remains serialized until authoritative rollback publication and then targets the newly visible prompt", async () => {
  const f = fixture();
  try {
    const first = f.owner.undo();
    await turn();
    assertEquals(f.owner.state.pending, "undo");
    assertEquals(f.session.state.content.revert, null);
    assertEquals(f.drafts.current("local/a").input, "");
    await f.owner.undo();
    assertEquals(f.calls, ["p2"]);
    f.session.update((state) => {
      state.content.revert = reverted("p2");
      state.loading = true;
    });
    await turn();
    assertEquals(f.owner.state.pending, "undo");
    f.session.update((state) => {
      state.content.messages = [message("p1")];
      state.loading = false;
    });
    await first;
    assertEquals(f.drafts.current("local/a").input, "p2");
    const second = f.owner.undo();
    await turn();
    assertEquals(f.calls, ["p2", "p1"]);
    f.session.update((state) => {
      state.content.revert = reverted("p1");
      state.content.messages = [];
    });
    await second;
    assertEquals(f.drafts.current("local/a").input, "p1");
  } finally {
    f.owner.dispose();
  }
});
Deno.test("redo waits for restored messages, not just a cleared boundary or completed RPC", async () => {
  const f = fixture();
  f.session.update((state) => {
    state.content.revert = reverted("p2");
    state.content.messages = [message("p1")];
  });
  try {
    const pending = f.owner.redo();
    await turn();
    assertEquals(f.owner.state.pending, "redo");
    f.session.update((state) => {
      state.content.revert = null;
    });
    await turn();
    assertEquals(f.owner.state.pending, "redo");
    f.session.update((state) => {
      state.loading = true;
      state.content.messages = [message("p1"), message("p2")];
    });
    await turn();
    assertEquals(f.owner.state.pending, "redo");
    f.session.update((state) => {
      state.loading = false;
    });
    await pending;
    assertEquals(f.owner.state.pending, undefined);
  } finally {
    f.owner.dispose();
  }
});
