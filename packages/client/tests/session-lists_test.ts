// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { Rpc } from "@otk/client";
import type {
  IntentIdentity,
  SessionListInput,
  SessionListPage,
} from "@otk/protocol";
import { createSessionLists } from "../session-lists.ts";

Deno.test("@load @sessions list demand fences replacement/reconnect chunks, retains last-good rows and appends only its requested boundary", async () => {
  const rpc = new Rpc(() => {}),
    reads: {
      input: SessionListInput;
      intent: IntentIdentity;
      signal: AbortSignal;
      resolve(page: SessionListPage): void;
    }[] = [];
  rpc.call = (_method, input, options) =>
    new Promise((resolve) => {
      const value = options as { intent: IntentIdentity; signal: AbortSignal };
      reads.push({
        input: input as SessionListInput,
        ...value,
        resolve: resolve as never,
      });
    }) as never;
  let epoch = 1;
  const owner = createSessionLists(rpc, () => epoch);
  const input = { directory: "/project" };
  const page = (
    at: number,
    id: string,
    generation = "source",
  ): SessionListPage => ({
    items: [{ id, title: id, directory: input.directory }],
    older: "older",
    load: {
      id: reads[at].intent.key,
      scope: {
        kind: "project-sessions",
        directory: input.directory,
        query: reads[at].input.query,
      },
      boundary: { kind: "page", limit: 20, before: reads[at].input.before },
      generation,
      revision: 2,
      state: "complete",
    },
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const list = owner.get(input);
    owner.viewport(list, ["first"]);
    reads[0].resolve(page(0, "first"));
    await tick();
    assertEquals(list.items.map((item) => item.id), ["first"]);
    owner.more(list);
    assertEquals(reads[1].input.before, "older");
    assertEquals(
      reads.length,
      2,
      "range acceptance before request settlement still acquires the reserve",
    );
    owner.viewport(list, []);
    reads[1].resolve(page(1, "second"));
    await tick();
    assertEquals(list.items.map((item) => item.id), ["first", "second"]);
    owner.activate({ ...input, query: "needle" });
    const query = owner.get({ ...input, query: "needle" });
    assertEquals(
      query.items.map((item) => item.id),
      ["first", "second"],
      "last-good data remains during replacement",
    );
    owner.receive({
      t: "load.chunk",
      request: reads[1].intent,
      epoch: 1,
      load: { ...page(1, "stale").load, revision: 99 },
      data: {
        kind: "session-list",
        items: page(1, "stale").items,
        older: null,
        offset: 0,
      },
    });
    assertEquals(query.items.map((item) => item.id), ["first", "second"]);
    epoch++;
    owner.refresh();
    assertEquals(reads[2].signal.aborted, true);
    reads[2].resolve(page(2, "retired", "old-source"));
    reads[3].resolve(page(3, "needle", "new-source"));
    await tick();
    assertEquals(query.items.map((item) => item.id), ["needle"]);
    assertEquals(query.loading, false);
    assertEquals(reads.length, 4, "reconnect reissues only the current query");
    assertEquals(reads[3].input.query, "needle");
    owner.receive({ t: "sessions.changed", directory: input.directory });
    owner.receive({ t: "sessions.changed", directory: input.directory });
    await tick();
    assertEquals(
      reads.length,
      5,
      "live changes coalesce one bounded replacement for the demanded list",
    );
    reads[4].resolve(page(4, "newly-created", "new-source"));
    await tick();
    assertEquals(query.items.map((item) => item.id), ["newly-created"]);
  } finally {
    owner.stop();
    rpc.close();
  }
});

Deno.test("@sessions page replacement preserves the acquired window and retained tombstones until its source boundary settles", async () => {
  const rpc = new Rpc(() => {});
  const reads: {
    input: SessionListInput;
    intent: IntentIdentity;
    resolve(page: SessionListPage): void;
  }[] = [];
  rpc.call = (_method, input, options) =>
    new Promise((resolve) => {
      reads.push({
        input: input as SessionListInput,
        intent: (options as { intent: IntentIdentity }).intent,
        resolve: resolve as never,
      });
    }) as never;
  const owner = createSessionLists(rpc, () => 1);
  const input = { directory: "/project", limit: 2 };
  const item = (id: string) => ({ id, title: id, directory: input.directory });
  const reply = (at: number, ids: string[], older: string | null) =>
    reads[at].resolve({
      items: ids.map(item),
      older,
      load: {
        id: reads[at].intent.key,
        scope: { kind: "project-sessions", directory: input.directory },
        boundary: { kind: "page", limit: 2, before: reads[at].input.before },
        generation: "source",
        revision: 1,
        state: "complete",
      },
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const list = owner.get(input);
    reply(0, ["a", "b"], "first");
    await tick();
    owner.more(list);
    reply(1, ["c", "deleted"], null);
    await tick();
    const acquired = list.items;
    const required = [{ ...item("deleted"), retained: true }];
    const structures = owner.structures(list, required);
    assertStrictEquals(owner.structures(list, required), structures);
    owner.receive({ t: "sessions.changed", directory: input.directory });
    await tick();
    reply(2, ["a", "b"], "replacement");
    await tick();
    assertEquals(
      list.items,
      acquired,
      "a refreshed first page cannot collapse a previously acquired window",
    );
    assertEquals(list.loading, true);
    assertEquals(reads[3].input.before, "replacement");
    reply(3, ["c"], null);
    await tick();
    assertEquals(list.items.map((entry) => entry.id), ["a", "b", "c"]);
    assertEquals(
      owner.structures(list, required) === structures,
      false,
      "a replaced page invalidates the structural projection even with unchanged context",
    );
    assertEquals(owner.structures(list, []).map((entry) => entry.id), [
      "a",
      "b",
      "c",
      "deleted",
    ]);
    assertEquals(
      owner.structures(list, [item("working-outside-page")]).map((entry) =>
        entry.id
      ),
      ["a", "b", "c", "deleted", "working-outside-page"],
    );
    assertEquals(list.loading, false);
  } finally {
    owner.stop();
    rpc.close();
  }
});
