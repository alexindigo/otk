// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createBranchHistory, createDrafts } from "@otk/client";
import type { ContentSession, Message, MessagePage } from "@otk/protocol";

const target = { sidecarId: "local", sessionID: "session" };
const session: ContentSession = {
  id: "session",
  title: "Capture by identity",
  directory: "/repo",
  projectID: "p",
  archived: false,
  time: { created: 1, updated: 1 },
  revert: { boundaryID: "p", messageIDs: ["p", "r"], files: [] },
};
type Scope = { messageIDs: string[]; validate?: boolean };
function fixture(
  options: { change?: boolean; fail?: boolean; quota?: boolean } = {},
) {
  const storage = new Map<string, string>(),
    reads: string[] = [],
    prompts: string[] = [];
  let seq = 0, revision = 0, failed = false, changed = false;
  let quota = !!options.quota, restored = false;
  const drafts = createDrafts();
  const message = (id: string): Message => ({
    id,
    sessionID: "session",
    role: "user",
    time: { created: id === "p" ? 2 : 3 },
    parts: [],
    source: { kind: "fixture", ref: id },
  });
  const owner = createBranchHistory({
    storage: {
      get length() {
        return storage.size;
      },
      key: (i) => [...storage.keys()][i] ?? null,
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        if (quota) throw new DOMException("full", "QuotaExceededError");
        storage.set(k, v);
      },
      removeItem: (k) => {
        storage.delete(k);
      },
    },
    server: () => "http://server",
    drafts,
    session: () =>
      Promise.resolve(restored ? { ...session, revert: undefined } : session),
    page: (
      _target: typeof target,
      _before?: string,
      _signal?: AbortSignal,
      scope?: Scope,
    ): Promise<MessagePage> => {
      if (!scope?.validate) {
        if (options.fail && !failed) {
          failed = true;
          return Promise.reject(new Error("transient read failure"));
        }
        reads.push(...scope?.messageIDs ?? ["old", "p", "r", "later"]);
      }
      return Promise.resolve({
        sessionID: "session",
        session: restored ? { ...session, revert: undefined } : session,
        items: scope?.validate
          ? []
          : (scope?.messageIDs ?? ["old", "p", "r", "later"]).map(message),
        clock: { epoch: "fixed", seq: ++seq },
        from: { epoch: "fixed", seq },
        revisions: Object.fromEntries(
          (scope?.messageIDs ?? []).map((
            id,
          ) => [id, id === "r" ? revision : 0]),
        ),
        version: { generation: 0, revision: 0 },
        older: null,
        helpers: {},
        recovering: [],
        catchup: [],
        turns: {},
      });
    },
    source: (_target, ref) => {
      if (options.change && ref === "r" && !changed) {
        revision++;
        changed = true;
      }
      return Promise.resolve({
        kind: "fixture",
        preview: ref + revision,
        bytes: 1,
        truncated: false,
      });
    },
    prompt: (_target, id) => {
      prompts.push(id);
      return Promise.resolve({ input: id, mode: "normal", time: 1, parts: [] });
    },
    attachments: (parts) => Promise.resolve(parts),
  });
  owner.select(target);
  return {
    owner,
    reads,
    prompts,
    drafts,
    restore: () => {
      restored = true;
    },
    quota: (value: boolean) => {
      quota = value;
    },
  };
}
Deno.test("revert capture saves only staged IDs despite unrelated sequence advances", async () => {
  const f = fixture();
  await f.owner.prepare(target, "p", session.revert!);
  assertEquals(f.reads, ["p", "r"]);
  assertEquals(f.owner.state.branches[0].messages.map((m) => m.id), ["p", "r"]);
});
Deno.test("revert capture rereads only an identity changed while its source was acquired", async () => {
  const f = fixture({ change: true });
  await f.owner.prepare(target, "p", session.revert!);
  assertEquals(f.reads, ["p", "r", "r"]);
  assertEquals(f.prompts, ["p", "r", "r"]);
  assertEquals(f.owner.state.branches[0].messages[1].source?.preview, "r1");
});
Deno.test("revert capture automatically retries a transient read and supports an explicit retry", async () => {
  const f = fixture({ fail: true });
  await f.owner.prepare(target, "p", session.revert!);
  assertEquals(f.owner.state.branches.length, 1);
  await f.owner.prepare(target, "p", session.revert!);
  assertEquals(f.reads, ["p", "r"]);
});

Deno.test("Restore after a completed failed capture keeps its immutable exact ID scope", async () => {
  const f = fixture({ quota: true });
  const transaction = f.drafts.reverts.capture("local/session");
  transaction.staged("p");
  const record = structuredClone(session.revert!);
  await assertRejects(() => f.owner.prepare(target, "p", record));
  record.messageIDs.push("later");
  f.restore();
  f.quota(false);
  await f.owner.settled(target, true);
  await f.owner.beforeCommit(target);
  assertEquals(f.reads, ["p", "r", "p", "r"]);
  assertEquals(f.owner.state.branches[0].messages.map((m) => m.id), ["p", "r"]);
});

Deno.test("archive acquisition without an identity record is refused before reading any page", async () => {
  const f = fixture();
  // @ts-expect-error The type contract requires the staged ID record.
  await assertRejects(() => f.owner.prepare(target, "p"));
  assertEquals(f.reads, []);
});

Deno.test("capture owns a plain immutable record when the view supplies a framework proxy", async () => {
  const f = fixture();
  await f.owner.prepare(target, "p", new Proxy(session.revert!, {}));
  assertEquals(f.reads, ["p", "r"]);
});
