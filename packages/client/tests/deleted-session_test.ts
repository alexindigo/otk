// SPDX-License-Identifier: LGPL-3.0-only
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import { assertEquals } from "@std/assert";
import { createSession } from "../session.ts";
import type { SidecarConnection } from "../connection.ts";
import { shellEntry } from "./shell-fixture.ts";
import { createInputGuard } from "../input-guard.ts";
import { createDrafts } from "../drafts.ts";
Deno.test("deleted selection is metadata-only, aborts live content, and resurrection acquires once", async () => {
  const entry = shellEntry("tstv1-one");
  entry.deleted = { at: 1, how: "provider" };
  const calls: unknown[] = [];
  const c = {
    messages: fixtureMessagePolicy,
    subscribe: (...args: unknown[]) => calls.push(args),
    supports: () => false,
    rpc: {
      call: (method: string, _p: unknown, signal?: AbortSignal) => {
        calls.push(method);
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason))
        );
      },
    },
  } as unknown as SidecarConnection;
  const session = createSession(() => c, () => entry);
  try {
    session.open({ sidecarId: "local", sessionID: entry.id });
    assertEquals(Reflect.get(session.state, "view"), "deleted");
    assertEquals(session.state.info?.title, entry.title);
    assertEquals(calls, []);
    delete entry.deleted;
    session.receive("local", { t: "index.snapshot", rev: 1, entries: [entry] });
    await Promise.resolve();
    assertEquals(Reflect.get(session.state, "view"), "content");
    assertEquals(calls.filter((call) => call === "session.messages").length, 1);
    entry.deleted = { at: 2, how: "provider" };
    session.receive("local", { t: "index.snapshot", rev: 2, entries: [entry] });
    assertEquals(Reflect.get(session.state, "view"), "deleted");
    assertEquals(session.state.content.messages, []);
    assertEquals(session.models, undefined);
  } finally {
    session.stop();
  }
});
Deno.test("deleted attention input survives view release until the normal guard is accepted", () => {
  let deleted = false, allow = false;
  const guard = createInputGuard({
    drafts: createDrafts(),
    key: () => "local/tstv1-one",
    confirm: () => allow,
    ...{ retain: () => deleted },
  });
  guard.mark("permissions", true, "Keep this unsent feedback");
  deleted = true;
  guard.mark("permissions", false);
  assertEquals(guard.dirty("permissions"), true);
  assertEquals(guard.retained(), [{
    owner: "permissions",
    value: "Keep this unsent feedback",
  }]);
  assertEquals(guard.release(), false);
  assertEquals(guard.retained().length, 1);
  allow = true;
  assertEquals(guard.release(), true);
  guard.clear();
  assertEquals(guard.retained(), []);
});

Deno.test("removing a server retires its catalog readiness before a new direct selection", () => {
  const calls: string[] = [];
  const c = {
    messages: fixtureMessagePolicy,
    subscribe() {},
    supports: () => false,
    rpc: {
      call: (method: string, _params: unknown, signal?: AbortSignal) => {
        calls.push(method);
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason))
        );
      },
    },
  } as unknown as SidecarConnection;
  const session = createSession(
    () => c,
    () => undefined,
    undefined,
    undefined,
    true,
  );
  try {
    session.open({ sidecarId: "local", sessionID: "tstv1-first" });
    assertEquals(calls, []);
    session.receive("local", { t: "index.snapshot", rev: 0, entries: [] });
    assertEquals(calls, ["session.messages"]);
    session.open();
    Reflect.apply(Reflect.get(session, "removeServer"), session, ["local"]);
    session.open({ sidecarId: "local", sessionID: "tstv1-next" });
    assertEquals(calls.length, 1);
    session.receive("local", { t: "index.snapshot", rev: 0, entries: [] });
    assertEquals(calls.length, 2);
  } finally {
    session.stop();
  }
});
