// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import * as client from "@otk/client";
import type { ContentSession, RevertInfo } from "@otk/protocol";

export function revertFixture(
  branchHistory?: Parameters<
    typeof client.createSessionRevert
  >[0]["branchHistory"],
) {
  const state: client.SessionState = {
    selection: { sidecarId: "local", sessionID: "a" },
    content: client.emptyContent(),
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  };
  const listeners = new Set<(state: client.SessionState) => void>();
  const calls: unknown[] = [];
  let result = Promise.resolve({ id: "a" } as ContentSession);
  const owner = client.createSessionRevert({
    branchHistory,
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
Deno.test("an absent stage closes a saved copy without consulting loaded messages", () => {
  const settlements: string[] = [];
  const branches: client.SavedBranch[] = [];
  const history = {
    state: {
      branches,
      pending: false,
    },
    prepare: () => Promise.resolve(),
    stageEnded: () => settlements.push("unconfirmed"),
    committed: () => settlements.push("replaced"),
  };
  const f = revertFixture(history);
  f.state.content.revert = { boundaryID: "p", messageIDs: ["p"], files: [] };
  f.change("a");
  branches.push({ pending: true } as client.SavedBranch);
  f.state.content.revert = null;
  f.change("a");
  assertEquals(settlements, ["unconfirmed"]);
  f.owner.dispose();
});
Deno.test("revert owner serializes intents without optimistic content and retires old selection results", async () => {
  const f = revertFixture(), held = Promise.withResolvers<ContentSession>();
  f.state.content.messages = [{
    id: "prompt",
    sessionID: "a",
    role: "user",
    time: { created: 1 },
    parts: [],
  }];
  f.result(held.promise);
  await f.owner.revertTo("prompt");
  const pending = f.owner.confirm();
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
  assertEquals(
    f.owner.state.error && f.owner.state.error.failure?.reason,
    "OTK has no further details",
  );
  f.result(Promise.resolve({ id: "b" } as ContentSession));
  await f.owner.restore();
  assertEquals(f.owner.state.error, undefined);
  assertEquals(f.state.content.revert, null);
  f.owner.dispose();
});
Deno.test("strip projects the boundary and exact message identities without counts", () => {
  const f = revertFixture();
  const revert: RevertInfo = {
    boundaryID: "p",
    messageIDs: ["p", "context", "reply"],
    files: [{ path: "a.ts", additions: 2, deletions: 1 }],
  };
  const strip = f.owner.strip({ ...client.emptyContent(), revert });
  assert(strip);
  assertEquals(strip, {
    boundaryID: "p",
    messageIDs: revert.messageIDs,
    preview: "p",
    files: revert.files,
  });
  assertEquals(f.owner.strip(client.emptyContent()), undefined);
  assertEquals(
    f.owner.strip({
      ...client.emptyContent(),
      revert: { boundaryID: "p", messageIDs: ["p"], files: [] },
    })?.boundaryID,
    "p",
  );
  f.owner.dispose();
});
