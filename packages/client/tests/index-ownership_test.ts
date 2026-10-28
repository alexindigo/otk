// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createIndex } from "../index.ts";
import { createState, type StateStore } from "../state.ts";
import { createServerResources } from "../server-resources.ts";
import { createSessionActions } from "../session-actions.ts";
import { createCurrentClient } from "../current.ts";
import { SidecarConnection } from "../connection.ts";
import { emptyContent } from "../reduce.ts";
import { shellEntry, shellInfo } from "./shell-fixture.ts";

Deno.test("accepted index writes govern captured action eligibility before deferred view publication", async () => {
  const pending: (() => void)[] = [];
  const deferred = <T extends object>(initial: T): StateStore<T> => {
    const store = createState(initial);
    return {
      ...store,
      update(change: (draft: T) => void) {
        pending.push(() => store.update(change));
      },
    };
  };
  const index = createIndex(deferred);
  const connection = new SidecarConnection("http://127.0.0.1:1502", {
    status() {},
    frame() {},
  });
  let nativeCalls = 0;
  connection.rpc.call = () => {
    nativeCalls++;
    return Promise.reject(new Error("Native admission must not happen"));
  };
  const resources = createServerResources({
    index,
    sidecars: () => ({
      state: {
        list: [{
          id: "local",
          baseUrl: "",
          label: "local",
          status: "connected",
          harness: "connected",
          capabilities: [],
          connectionVersion: 1,
        }],
      },
      subscribe: () => () => {},
      connection: () => connection,
      start() {},
      stop() {},
      add: () => Promise.resolve("local"),
      remove() {},
    }),
  });
  const target = { sidecarId: "local", sessionID: "tstv1-one" };
  const session = {
    state: {
      selection: target,
      info: shellInfo(target.sessionID),
      content: emptyContent(),
      siblings: [],
      loading: false,
      paging: false,
      exhausted: true,
      continuity: "ready" as const,
    },
  };
  const actions = createSessionActions({
    resources,
    session,
    current: createCurrentClient(() => target, () => connection),
  });
  try {
    resources.receive("local", {
      t: "index.snapshot",
      rev: 0,
      entries: [shellEntry(target.sessionID)],
    });
    for (const flush of pending.splice(0)) flush();
    assertEquals(actions.eligibility(target).live, true);
    resources.receive("local", {
      t: "index.patch",
      rev: 1,
      ops: [{
        op: "digest",
        id: target.sessionID,
        revision: 1,
        summary: { state: "ready", revision: 1 },
        turns: { upsert: {}, remove: [] },
        deleted: { at: 1, how: "provider" },
      }],
    });
    assertEquals(actions.eligibility(target).live, false);
    await assertRejects(
      () => actions.rename(target, "Captured stale action"),
      Error,
      "deleted",
    );
    assertEquals(nativeCalls, 0);
  } finally {
    resources.stop();
    connection.rpc.close();
  }
});
