// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  createDirectoryCatalogs,
  createSession,
  SidecarConnection,
} from "@otk/client";
import { createCatalogCodecs } from "@otk/protocol";
import {
  connectRequests,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import {
  fixtureMessagePolicy,
  fixturePage,
} from "../../../tests/support/message-pages.ts";

for (const borrowed of [true, false]) {
  Deno.test(`session bootstrap respects catalog ownership and server identity (borrowed=${borrowed})`, async () => {
    let watches = 0, refreshes = 0, modelReads = 0;
    let directory = "/p";
    const value = { providers: [], defaultState: "unknown" as const };
    const moved = {
      providers: [{ id: "nested", name: "Nested folder", models: [] }],
      defaultState: "unknown" as const,
    };
    const catalogs = createDirectoryCatalogs({
      codecs: createCatalogCodecs(),
      demand: () => Promise.resolve(),
      watch(directory) {
        watches++;
        return {
          result: Promise.resolve({
            directory,
            generation: "g",
            revision: 0,
            paths: { style: "posix" as const, separator: "/" as const },
            values: {
              models: {
                state: "ready" as const,
                revision: 0,
                value: directory === "/p" ? value : moved,
              },
            },
          }),
          release() {},
        };
      },
      refresh() {
        refreshes++;
        return Promise.resolve();
      },
    });
    const connection = new SidecarConnection("http://example.test", {
      status() {},
      frame() {},
    }, { messages: fixtureMessagePolicy });
    connection.supports = (name) => name === "models";
    connection.subscribe = () => {};
    connection.send = (frame) => {
      if (frame.t !== "request") return;
      if (frame.method === "models.list") modelReads++;
      const result = frame.method === "session.messages"
        ? fixturePage("s", [], undefined, {
          id: "s",
          directory,
          title: "Selected",
          projectID: "p",
          archived: false,
          time: { created: 1, updated: 1 },
        })
        : frame.method === "models.list"
        ? directory === "/p" ? value : moved
        : [];
      queueMicrotask(() => replyRequest(connection.rpc, frame, result));
    };
    connectRequests(connection.rpc);
    const session = createSession(
      () => connection,
      () => ({
        id: "s",
        directory,
        title: "Selected",
        projectID: "p",
        archived: false,
        status: "idle",
        timeCreated: 1,
        timeUpdated: 1,
        attention: {
          permissions: 0,
          childPermissions: 0,
          questions: 0,
          childQuestions: 0,
        },
        digest: { state: "digesting", revision: 0, turns: {} },
      }),
      undefined,
      undefined,
      false,
      undefined,
      borrowed
        ? (_target, directory) => ({
          directory: catalogs.acquire(directory),
          frecency: {
            entries: [],
            scores: new Map(),
            revision: 0,
            subscribe: () => () => {},
            ready: () => Promise.resolve(),
            release() {},
          },
        })
        : undefined,
    );
    const settle = async () => {
      for (let n = 0; n < 40; n++) await Promise.resolve();
    };
    try {
      session.open({ sidecarId: "core", sessionID: "s" });
      await settle();
      assert(session.models);
      await session.models.ready();
      const initial = modelReads;
      assertEquals(initial, borrowed ? 0 : 1);
      for (let n = 0; n < 10; n++) {
        session.receive("other", { t: "bootstrap.complete" });
      }
      await settle();
      assertEquals(modelReads, initial);
      assertEquals(refreshes, 0);
      session.receive("core", { t: "bootstrap.complete" });
      await settle();
      assertEquals(
        refreshes,
        0,
        "Borrowed directory values have their own native invalidation owner",
      );
      assertEquals(
        modelReads,
        initial + (borrowed ? 0 : 1),
        "The standalone owned catalog retains its bootstrap contract",
      );
      await session.models.refresh();
      assertEquals(
        refreshes,
        borrowed ? 1 : 0,
        "Explicit refresh still reaches the directory owner",
      );
      assertEquals(watches, borrowed ? 1 : 0);
      const previous = session.models, beforeMove = modelReads;
      directory = "/p/nested";
      session.receive("core", { t: "index.patch", rev: 1, ops: [] });
      await settle();
      assert(session.models);
      await session.models.ready();
      assertStrictEquals(session.models, previous);
      assertEquals(
        session.models.state.value?.providers[0].name,
        "Nested folder",
      );
      assertEquals(watches, borrowed ? 2 : 0);
      assertEquals(modelReads, beforeMove + (borrowed ? 0 : 1));
    } finally {
      session.stop();
      catalogs.stop();
      connection.stop();
    }
  });
}
