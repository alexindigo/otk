// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createDrafts,
  createSessionRevert,
  createState,
  emptyContent,
  type SessionState,
} from "@otk/client";
import type { ContentSession, HistoryEntry, Message } from "@otk/protocol";
const info = (): ContentSession => ({
  id: "a",
  directory: "/project",
  title: "A",
  projectID: "p",
  time: { created: 1, updated: 1 },
  archived: false,
});

const prompt = (id: string): Message => ({
  id,
  sessionID: "a",
  role: "user",
  time: { created: 1 },
  parts: [],
});
const history = (input: string): HistoryEntry => ({
  input,
  mode: "normal",
  time: 1,
  parts: [{ kind: "text", text: input }, {
    kind: "file",
    source: "history",
    name: "image.png",
    mime: "image/png",
    size: 3,
    messageID: input,
    partID: "file",
  }],
});
function fixture() {
  const session = createState<SessionState>({
    selection: { sidecarId: "local", sessionID: "a" },
    content: { ...emptyContent(), messages: [prompt("p1"), prompt("p2")] },
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  });
  const drafts = createDrafts(), status = createState({ working: false });
  const calls: unknown[] = [];
  let result: Promise<ContentSession> | undefined;
  const owner = createSessionRevert({
    session,
    drafts,
    status: {
      working: () => status.state.working,
      subscribe: status.subscribe,
    },
    actions: {
      abort: (target) => {
        calls.push(["abort", target]);
        return Promise.resolve();
      },
      revert: (target, id) => {
        calls.push(["revert", target, id]);
        return result ??
          Promise.resolve(
            {
              ...info(),
              revert: {
                messageID: id,
                messageCount: 1,
                files: [],
                prompt: history(id),
              },
            },
          );
      },
      restore: (target) => {
        calls.push(["restore", target]);
        return result ?? Promise.resolve(info());
      },
    },
  });
  const publish = (id?: string) => {
    if (session.state.selection?.sessionID !== "a") return;
    session.update((state) => {
      state.content.revert = id
        ? {
          messageID: id,
          messageCount: id === "p1" ? 2 : 1,
          files: [],
          prompt: history(id),
        }
        : null;
      state.content.messages = id === "p1"
        ? []
        : id === "p2"
        ? [prompt("p1")]
        : [prompt("p1"), prompt("p2")];
      state.loading = false;
    });
  };
  return {
    session,
    drafts,
    status,
    calls,
    owner,
    publish,
    async undo(id: string) {
      const work = owner.undo();
      publish(id);
      await work;
    },
    async redo() {
      const work = owner.redo();
      publish();
      await work;
    },
    result: (value: Promise<ContentSession>) => {
      result = value;
    },
  };
}
Deno.test("undo recalls only into empty/owned drafts and redo clears only owned content while keeping choices", async () => {
  const f = fixture(), write = f.drafts.writer("local/a");
  write((draft) => ({
    ...draft,
    agent: "review",
    model: { provider: "chosen", model: "model" },
    variant: undefined,
  }));
  try {
    await f.undo("p2");
    assertEquals(f.drafts.current("local/a").input, "p2");
    assertEquals(f.drafts.current("local/a").chips[0].part.kind, "file");
    assertEquals(
      f.session.state.content.revert?.messageID,
      "p2",
      "The fixture publishes authoritative rollback separately from its RPC",
    );
    await f.undo("p1");
    assertEquals(f.drafts.current("local/a").input, "p1");
    await f.redo();
    const draft = f.drafts.current("local/a");
    assertEquals(draft.input, "");
    assertEquals(draft.chips, []);
    assertEquals(draft.agent, "review");
    assertEquals(draft.model, { provider: "chosen", model: "model" });
    assertEquals(Object.hasOwn(draft, "variant"), true);
    await f.undo("p2");
    write((draft) => ({ ...draft, input: "User edit" }));
    await f.undo("p1");
    assertEquals(f.drafts.current("local/a").input, "User edit");
    await f.redo();
    assertEquals(f.drafts.current("local/a").input, "User edit");
  } finally {
    f.owner.dispose();
  }
});
Deno.test("undo and redo preserve newer edits, unsaved editors and retired draft writers across asynchronous completion", async () => {
  for (const kind of ["edit", "editor", "drop", "selection"] as const) {
    const f = fixture(),
      write = f.drafts.writer("local/a"),
      held = Promise.withResolvers<ContentSession>();
    try {
      f.result(held.promise);
      const pending = f.owner.undo();
      if (kind === "edit") {
        write((draft) => ({ ...draft, input: "Newer input" }));
      }
      if (kind === "editor") {
        write((draft) => ({ ...draft, editor: { text: "Unsaved editor" } }));
      }
      if (kind === "drop") f.drafts.drop("local/a");
      if (kind === "selection") {
        f.session.update((state) => {
          state.selection = { sidecarId: "local", sessionID: "b" };
        });
      }
      held.resolve(
        {
          ...info(),
          revert: {
            messageID: "p2",
            messageCount: 1,
            files: [],
            prompt: history("p2"),
          },
        },
      );
      f.publish("p2");
      await pending;
      const draft = f.drafts.current("local/a");
      assertEquals(draft.input, kind === "edit" ? "Newer input" : "");
      assertEquals(
        draft.editor,
        kind === "editor" ? { text: "Unsaved editor" } : undefined,
      );
      assertEquals(f.drafts.current("local/b").input, "");
    } finally {
      f.owner.dispose();
    }
  }
  const f = fixture();
  try {
    await f.undo("p2");
    const held = Promise.withResolvers<ContentSession>();
    f.result(held.promise);
    const pending = f.owner.redo();
    f.drafts.writer("local/a")((draft) => ({
      ...draft,
      input: "Edited during redo",
    }));
    held.resolve(info());
    f.publish();
    await pending;
    assertEquals(f.drafts.current("local/a").input, "Edited during redo");
  } finally {
    f.owner.dispose();
  }
});
Deno.test("undo aborts its captured working session and waits for authoritative idle before reverting", async () => {
  const f = fixture();
  f.status.update((state) => {
    state.working = true;
  });
  try {
    const pending = f.owner.undo();
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(f.calls, [["abort", { sidecarId: "local", sessionID: "a" }]]);
    assertEquals(f.owner.state.pending, "undo");
    await f.owner.redo();
    assertEquals(f.calls.length, 1);
    f.status.update((state) => {
      state.working = false;
    });
    f.publish("p2");
    await pending;
    assertEquals(f.calls.at(-1), ["revert", {
      sidecarId: "local",
      sessionID: "a",
    }, "p2"]);
  } finally {
    f.owner.dispose();
  }
});
Deno.test("selection retirement cancels an idle wait without reverting or writing into another session", async () => {
  const f = fixture();
  f.status.update((state) => {
    state.working = true;
  });
  try {
    const pending = f.owner.undo();
    await Promise.resolve();
    f.session.update((state) => {
      state.selection = { sidecarId: "local", sessionID: "b" };
    });
    await pending;
    f.status.update((state) => {
      state.working = false;
    });
    assertEquals(f.calls, [["abort", { sidecarId: "local", sessionID: "a" }]]);
    assertEquals(f.owner.state.error, undefined);
    assertEquals(f.drafts.current("local/a").input, "");
  } finally {
    f.owner.dispose();
  }
});
Deno.test("undo reports the bounded stopping timeout and never reverts a still-working session", async () => {
  const f = fixture();
  f.status.update((state) => {
    state.working = true;
  });
  try {
    await f.owner.undo();
    assertEquals(
      f.owner.state.error,
      "The session is still stopping. Try Undo again.",
    );
    assertEquals(f.calls.length, 1);
    assertEquals(f.owner.state.pending, undefined);
  } finally {
    f.owner.dispose();
  }
});
