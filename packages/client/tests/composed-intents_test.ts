// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createInbox,
  createSessionActions,
  type RequestOptions,
} from "@otk/client";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

Deno.test("repeated delete joins its captured interrupt and deletion before asynchronous preparation", async () => {
  const f = shellFixture();
  f.entries("local", [{ ...shellEntry("selected"), status: "busy" }]);
  const rpc = f.resources.sidecars.connection("local").rpc;
  const call = rpc.call.bind(rpc), options: RequestOptions[] = [];
  rpc.call = (method, params, input) => {
    if (input && !(input instanceof AbortSignal)) options.push(input);
    return call(method, params, input);
  };
  const held = Promise.withResolvers<void>();
  f.reply((_id, method) =>
    method === "session.abort" ? held.promise : Promise.resolve(null)
  );
  const actions = createSessionActions(f);
  const target = { sidecarId: "local", sessionID: "selected" };
  const first = actions.remove(target), duplicate = actions.remove(target);
  held.resolve();
  await Promise.all([first, duplicate]);
  assertEquals(f.calls.filter((c) => c[1] === "session.abort").length, 1);
  assertEquals(f.calls.filter((c) => c[1] === "session.delete").length, 1);
  assert(options.length >= 2);
  assert(options.every((o) => o.intent?.key && o.owner === "selected"));
  assertEquals(new Set(options.map((o) => o.intent?.key)).size, options.length);
  f.resources.stop();
});

Deno.test("submission allocates distinct promotion send and visit keys before asynchronous work", async () => {
  const f = shellFixture();
  f.entries("local", [shellEntry("selected")]);
  const rpc = f.resources.sidecars.connection("local").rpc;
  const call = rpc.call.bind(rpc), options: RequestOptions[] = [];
  rpc.call = (method, params, input) => {
    if (input && !(input instanceof AbortSignal)) options.push(input);
    return call(method, params, input);
  };
  const actions = createSessionActions(f);
  await actions.submission({ sidecarId: "local", sessionID: "selected" })(
    (input?: RequestOptions) =>
      rpc.call("session.abort", { sessionID: "selected" }, input),
  );
  assertEquals(options.length, 3);
  assert(options.every((o) => o.intent?.key && o.owner === "selected"));
  assertEquals(new Set(options.map((o) => o.intent?.key)).size, 3);
  assertEquals(new Set(options.map((o) => o.intent?.clientID)).size, 1);
  f.resources.stop();
});

Deno.test("a held post-success visit cannot hold the successful action result", async () => {
  const visit = Promise.withResolvers<null>();
  const inbox = createInbox({ call: () => visit.promise as never });
  let result: unknown;
  const work = inbox.act("/p", () => Promise.resolve("sent"));
  void work.then((value) => result = value);
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  const observed = result;
  visit.resolve(null);
  await work;
  assertEquals(observed, "sent");
});
