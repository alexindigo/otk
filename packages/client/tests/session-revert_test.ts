// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import * as client from "@otk/client";
import type { ContentSession, RevertInfo } from "@otk/protocol";

export function revertFixture() {
  const state: client.SessionState = {
    selection: { sidecarId: "local", sessionID: "a" },
    content: client.emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  };
  const listeners = new Set<(state: client.SessionState) => void>();
  const calls: unknown[] = [];
  let result = Promise.resolve({ id: "a" } as ContentSession);
  const owner = client.createSessionRevert({
    drafts: client.createDrafts(),
    status: { working: () => false, subscribe: () => () => {} },
    session: {
      state,
      subscribe: (listener: (state: client.SessionState) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    actions: {
      abort: () => Promise.resolve(),
      revert: (target, messageID) => {
        calls.push(["revert", target, messageID]);
        return result;
      },
      restore: (target) => {
        calls.push(["restore", target]);
        return result;
      },
    },
  });
  return {
    state,
    calls,
    owner,
    result: (value: Promise<ContentSession>) => {
      result = value;
    },
    change: (id: string) => {
      state.selection = { sidecarId: "local", sessionID: id };
      for (const listener of listeners) listener(state);
    },
  };
}
Deno.test("revert owner serializes intents without optimistic content and retires old selection results", async () => {
  const f = revertFixture(), held = Promise.withResolvers<ContentSession>();
  f.result(held.promise);
  const pending = f.owner.revertTo("prompt");
  assertEquals(f.owner.state.pending, "revert");
  assertEquals(f.state.content.revert, null);
  await f.owner.restore();
  assertEquals(f.calls.length, 1);
  f.change("b");
  assertEquals(f.owner.state.pending, undefined);
  held.reject(new Error("Old failure"));
  await pending;
  assertEquals(f.owner.state.error, undefined);
  f.result(Promise.reject(new Error("Restore refused")));
  await f.owner.restore();
  assertEquals(f.owner.state.error, "Restore refused");
  f.result(Promise.resolve({ id: "b" } as ContentSession));
  await f.owner.restore();
  assertEquals(f.owner.state.error, undefined);
  assertEquals(f.state.content.revert, null);
  f.owner.dispose();
});
Deno.test("strip projects authoritative counts, bounded prompts and files including older-server fallback", () => {
  const f = revertFixture();
  const revert: RevertInfo = {
    messageID: "p",
    messageCount: 52,
    files: [{ path: "a.ts", additions: 2, deletions: 1 }],
    prompts: [{ messageID: "p", preview: "Boundary preview", time: 1 }],
  };
  const strip = f.owner.strip({ ...client.emptyContent(), revert });
  assert(strip);
  assertEquals(strip, {
    count: 52,
    preview: "Boundary preview",
    prompts: revert.prompts,
    more: 51,
    files: revert.files,
  });
  assertEquals(f.owner.strip(client.emptyContent()), undefined);
  assertEquals(
    f.owner.strip({
      ...client.emptyContent(),
      revert: { messageID: "p", messageCount: 2, files: [] },
    })?.more,
    2,
  );
  f.owner.dispose();
});
