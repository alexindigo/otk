// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createDrafts,
  createSessionRevert,
  emptyContent,
  type SavedBranch,
  type SessionState,
} from "@otk/client";

Deno.test("the revert retires saved-copy actions when its archive is deleted", () => {
  const target = { sidecarId: "local", sessionID: "a" };
  const info = {
    id: "a",
    title: "Copy lifetime",
    directory: "/project",
    projectID: "p",
    archived: false,
    time: { created: 1, updated: 1 },
  };
  const state: SessionState = {
    selection: target,
    content: {
      ...emptyContent(),
      revert: { boundaryID: "p", messageIDs: [], files: [] },
    },
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  };
  const history = {
    branches: [
      {
        id: "copy",
        boundary: "p",
        pending: true,
        messages: [],
      } as unknown as SavedBranch,
    ],
    pending: false,
  };
  let notify = () => {}, captures = 0;
  const owner = createSessionRevert({
    session: { state, subscribe: () => () => {} },
    drafts: createDrafts(),
    status: { working: () => false, subscribe: () => () => {} },
    actions: {
      abort: () => Promise.resolve(),
      revert: () => Promise.resolve(info),
      restore: () => Promise.resolve(info),
    },
    branchHistory: {
      state: history,
      prepare: () => {
        captures++;
        return Promise.resolve();
      },
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    },
  });
  assertEquals(owner.state.phase, "saved");
  history.branches = [];
  notify();
  assertEquals(owner.state.phase, "staged");
  assertEquals(Reflect.get(owner.state, "copyRemoved"), true);
  assertEquals(owner.state.error, undefined);
  notify();
  assertEquals(captures, 0);
  owner.dispose();
});
