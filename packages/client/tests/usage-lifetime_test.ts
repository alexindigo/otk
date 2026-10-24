// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createSessionUsage } from "../session-usage.ts";
import { SidecarConnection } from "../connection.ts";
import { type SessionUsage, UsageLedger } from "@otk/protocol";
Deno.test("usage leases coalesce independent consumers and last release cancels and erases the target", async () => {
  const held = Promise.withResolvers<SessionUsage>();
  let signal: AbortSignal | undefined;
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  });
  connection.supports = () => true;
  connection.rpc.call = (_method, _params, abort) => {
    signal = abort;
    return held.promise as never;
  };
  const owner = createSessionUsage(() => connection),
    target = { sidecarId: "remote", sessionID: "s" };
  const first = owner.retain(target), second = owner.retain(target);
  const work = owner.load(target);
  await Promise.resolve();
  first();
  assertEquals(signal?.aborted, false);
  second();
  second();
  assert(signal?.aborted);
  held.resolve(new UsageLedger("s").snapshot());
  await work;
  assertEquals(owner.get(target), undefined);
  assertEquals(owner.state.entries, {});
  owner.stop();
});
Deno.test("usage session and server removal invalidate retained ledgers and ignore late results", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  });
  connection.supports = () => true;
  connection.rpc.call = (_method, params) =>
    Promise.resolve(
      new UsageLedger((params as { sessionID: string }).sessionID).snapshot(),
    ) as never;
  const owner = createSessionUsage(() => connection);
  const targets = ["s", "other"].map((sessionID) => ({
    sidecarId: "remote",
    sessionID,
  }));
  for (const target of targets) await owner.load(target);
  owner.receive("remote", {
    t: "index.patch",
    rev: 1,
    ops: [{ op: "remove", id: "s" }],
  });
  assertEquals(
    owner.get(targets[0]),
    undefined,
    "Deleted session ledger remains retained",
  );
  owner.removeServer("remote");
  assertEquals(owner.state.entries, {});
  owner.stop();
});
Deno.test("one-shot usage reads have bounded retention", async () => {
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  });
  connection.supports = () => true;
  connection.rpc.call = (_method, params) =>
    Promise.resolve(
      new UsageLedger((params as { sessionID: string }).sessionID).snapshot(),
    ) as never;
  const owner = createSessionUsage(() => connection);
  for (let n = 0; n < 100; n++) {
    await owner.load({ sidecarId: "remote", sessionID: String(n) });
  }
  assert(
    Object.keys(owner.state.entries).length <= 32,
    "Usage resources grow with every visited target",
  );
  assertEquals(owner.get({ sidecarId: "remote", sessionID: "0" }), undefined);
  assert(owner.get({ sidecarId: "remote", sessionID: "99" }));
  owner.stop();
});
