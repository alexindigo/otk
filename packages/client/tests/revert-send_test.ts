// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createBranchHistory, createDrafts } from "@otk/client";
import type { ContentSession, MessagePage } from "@otk/protocol";
const target = { sidecarId: "local", sessionID: "s" };
function fixture(current = false) {
  let quota = true, staged = true, reads = 0;
  const values = new Map<string, string>();
  const session = (): ContentSession => ({
    id: "s",
    title: "S",
    directory: "/repo",
    projectID: "p",
    archived: false,
    time: { created: 1, updated: 1 },
    ...(staged
      ? { revert: { boundaryID: "p", messageIDs: ["p"], files: [] } }
      : {}),
  });
  const drafts = createDrafts();
  drafts.writer("local/s")((d) => ({ ...d, input: "Captured replacement" }));
  const owner = createBranchHistory({
    drafts,
    ...(current ? { current: session } : {}),
    server: () => "http://server",
    storage: {
      get length() {
        return values.size;
      },
      key: (at) => [...values.keys()][at] ?? null,
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        if (quota) throw new DOMException("full", "QuotaExceededError");
        values.set(key, value);
      },
    },
    session: () => {
      reads++;
      return Promise.resolve(session());
    },
    page: (_target, _before, _signal, scope): Promise<MessagePage> =>
      Promise.resolve({
        sessionID: "s",
        session: session(),
        items: scope?.validate ? [] : [{
          id: "p",
          sessionID: "s",
          role: "user",
          time: { created: 1 },
          parts: [],
        }],
        revisions: { p: 0 },
        from: { epoch: "e", seq: 0 },
        clock: { epoch: "e", seq: 0 },
        version: { generation: 1, revision: 1 },
        older: null,
        turns: {},
        helpers: {},
        recovering: [],
        catchup: [],
      }),
    prompt: () =>
      Promise.resolve({
        input: "Original",
        mode: "normal",
        time: 1,
        parts: [],
      }),
    source: () => {
      throw new Error("No source");
    },
    attachments: (parts) => Promise.resolve(parts),
  });
  owner.select(target);
  const choice = () =>
    new Promise<void>((resolve) => {
      if (owner.state.permanence) return resolve();
      const stop = owner.subscribe(() => {
        if (owner.state.permanence) {
          stop();
          resolve();
        }
      });
    });
  return {
    owner,
    drafts,
    values,
    choice,
    reads: () => reads,
    quota: (value: boolean) => {
      quota = value;
    },
    clear: () => {
      staged = false;
    },
  };
}
Deno.test("an acquired unstaged transcript admits local Send without a redundant native read, then revalidates dispatch", async () => {
  const f = fixture(true);
  f.clear();
  const permit = await f.owner.beforeSend(target);
  assertEquals(f.reads(), 0);
  await f.owner.beforeCommit(target, undefined, permit);
  assertEquals(f.reads(), 1);
});
Deno.test("unsaved Send presents a boundary-specific choice and explicit Send anyway grants that invocation", async () => {
  const f = fixture();
  let released = false;
  const pending = f.owner.beforeSend(target).then((permit) => {
    released = true;
    return permit;
  });
  await f.choice();
  assertEquals(released, false);
  assertEquals(f.owner.state.permanence?.boundaryID, "p");
  const feedback = f.owner.state.permanence!.error;
  assertEquals(
    feedback && typeof feedback === "object" && feedback.failure?.heading,
    "Sending makes the revert permanent",
  );
  assertEquals(f.drafts.current("local/s").input, "Captured replacement");
  await f.owner.sendAnyway();
  const permit = await pending;
  await f.owner.beforeCommit(target, undefined, permit);
  assertEquals(released, true);
});
Deno.test("Save copy retries preservation then releases Send only after a durable copy exists", async () => {
  const f = fixture(), pending = f.owner.beforeSend(target);
  await f.choice();
  f.quota(false);
  await f.owner.saveCopy();
  const permit = await pending;
  assertEquals(f.owner.state.branches[0].messages.map((m) => m.id), ["p"]);
  await f.owner.beforeCommit(target, undefined, permit);
  assertEquals(f.owner.state.permanence, undefined);
});
Deno.test("Restore cancels a waiting Send rather than releasing it on the restored conversation", async () => {
  const f = fixture(), pending = f.owner.beforeSend(target);
  const rejected = assertRejects(() => pending, DOMException);
  await f.choice();
  f.clear();
  f.owner.restored(target);
  await rejected;
  assertEquals(f.owner.state.permanence, undefined);
  assertEquals(f.drafts.current("local/s").input, "Captured replacement");
});

Deno.test("a saved-copy grant cannot silently discard history if its copy is deleted before dispatch", async () => {
  const f = fixture();
  f.quota(false);
  const permit = await f.owner.beforeSend(target);
  f.values.clear();
  await assertRejects(
    () => f.owner.beforeCommit(target, undefined, permit),
    Error,
    "saved copy was removed",
  );
  assertEquals(f.drafts.current("local/s").input, "Captured replacement");
});
