// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import { V2SessionLists } from "../session-lists.ts";
import { V2Client } from "../client.ts";
import type { NativeSession } from "../metadata.ts";
const raw = (id: string): NativeSession => ({
  id,
  projectID: "p",
  location: { directory: "/repo" },
  title: id,
  time: { created: 1, updated: 2, idle: id === "ses_first" ? 20 : 10 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
Deno.test("V2 list cursor binds scope, size, generation and mode; cursor API pages omit first-page filters", async () => {
  const requests: Record<string, unknown>[] = [], owner = new AbortController();
  const client = new V2Client(
    { endpoint: { url: "http://127.0.0.1:42" }, version: "2.2.6", pid: 42 },
    1000,
    owner.signal,
    (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/message")) {
        return Promise.resolve(Response.json({ data: [], cursor: {} }));
      }
      requests.push(Object.fromEntries(url.searchParams));
      return Promise.resolve(Response.json(
        url.searchParams.has("cursor")
          ? { data: [raw("ses_second")], cursor: {} }
          : { data: [raw("ses_first")], cursor: { next: "opaque-native" } },
      ));
    },
  );
  const lists = new V2SessionLists(),
    signal = owner.signal,
    input = { directory: "/repo", parentID: null, limit: 1 };
  const first = await lists.read(input, client, undefined, signal);
  const second = await lists.read(
    { ...input, before: first.older! },
    client,
    undefined,
    signal,
  );
  assertEquals(second.items[0].id, "opcv2-ses_second");
  assertEquals(second.older, null);
  assertEquals(requests, [
    {
      directory: "/repo",
      parentID: "null",
      limit: "200",
      order: "desc",
    },
    { cursor: "opaque-native", limit: "200" },
    {
      directory: "/repo",
      parentID: "null",
      limit: "200",
      order: "desc",
    },
    { cursor: "opaque-native", limit: "200" },
  ]);
  assertEquals(
    (await assertRejects(() =>
      lists.read(
        { ...input, limit: 2, before: first.older! },
        client,
        undefined,
        signal,
      ), OperationFailure)).outcome,
    "rejected",
  );
  lists.reset();
  assertEquals(
    (await assertRejects(
      () =>
        lists.read(
          { ...input, before: first.older! },
          client,
          undefined,
          signal,
        ),
      OperationFailure,
    )).outcome,
    "rejected",
  );
  await assertRejects(
    () => lists.read({ ...input, limit: 201 }, client, undefined, signal),
    OperationFailure,
  );
  assertEquals(requests.length, 4);
});
Deno.test("V2 list pages retire on cancellation and detect nonadvancing native cursors", async () => {
  const owner = new AbortController();
  const client = new V2Client(
    { endpoint: { url: "http://127.0.0.1:42" }, version: "2.2.6", pid: 42 },
    1000,
    owner.signal,
    (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/message")) {
        return Promise.resolve(Response.json({ data: [], cursor: {} }));
      }
      return Promise.resolve(
        Response.json({ data: [raw("ses_first")], cursor: { next: "same" } }),
      );
    },
  );
  const lists = new V2SessionLists(), input = { directory: "/repo", limit: 1 };
  await assertRejects(
    () =>
      lists.read(
        input,
        client,
        undefined,
        owner.signal,
      ),
    Error,
    "did not advance",
  );
  owner.abort(new DOMException("retired", "AbortError"));
  await assertRejects(
    () => lists.read(input, client, undefined, owner.signal),
    DOMException,
    "retired",
  );
});
