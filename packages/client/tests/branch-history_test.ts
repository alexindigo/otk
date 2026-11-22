// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createBranchHistory,
  createDrafts,
  emptyDraft,
  savedPromptDraft,
} from "@otk/client";
import type { ContentSession, Message, MessagePage } from "@otk/protocol";
declare module "@otk/protocol" {
  interface PartKinds {
    "branch-fixture": { kind: "branch-fixture"; id: string; opaque: string };
  }
}
const target = { sidecarId: "server", sessionID: "a" };
const info = (id = "a"): ContentSession => ({
  id,
  title: "Earlier",
  directory: "/project",
  projectID: "p",
  archived: false,
  time: { created: 1, updated: 1 },
});
const message = (id: string): Message => ({
  id,
  sessionID: "a",
  role: "user",
  time: { created: Number(id) },
  parts: [],
  source: { kind: "fixture", ref: `source:${id}` },
});
function fixture() {
  const values = new Map<string, string>();
  let quota = false, staged = false, calls = 0;
  const drafts = createDrafts();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem(k: string, v: string) {
      if (quota) throw new DOMException("full", "QuotaExceededError");
      values.set(k, v);
    },
    removeItem(k: string) {
      values.delete(k);
    },
  };
  const options = {
    storage,
    drafts,
    server: (t: typeof target) => t.sidecarId,
    session: (t: typeof target): Promise<ContentSession> =>
      Promise.resolve({
        ...info(t.sessionID),
        ...(staged
          ? { revert: { boundaryID: "2", messageIDs: ["2"], files: [] } }
          : {}),
      }),
    page: (t: typeof target, before?: string): Promise<MessagePage> => {
      calls++;
      return Promise.resolve({
        sessionID: t.sessionID,
        session: info(t.sessionID),
        items: [message(before ? "1" : "2")],
        clock: { epoch: "e", seq: 1 },
        from: { epoch: "e", seq: 1 },
        version: { generation: 1, revision: 1 },
        older: before ? null : "older",
        turns: {},
        helpers: {},
        recovering: [],
        catchup: [],
      });
    },
    prompt: (_t: typeof target, id: string) =>
      Promise.resolve({
        input: `Exact\n  prompt ${id}`,
        mode: "normal" as const,
        parts: [{
          kind: "file" as const,
          source: "history" as const,
          messageID: id,
          partID: "f",
          name: "file.txt",
          mime: "text/plain",
          size: 3,
        }],
        time: 1,
      }),
    source: (_t: typeof target, ref: string) =>
      Promise.resolve({
        kind: "fixture",
        preview: ref,
        bytes: ref.length,
        truncated: false,
      }),
    attachments: (parts: import("@otk/protocol").PromptPart[]) =>
      Promise.resolve(
        parts.map((p) =>
          p.kind === "file" && p.source === "history"
            ? {
              kind: "file" as const,
              source: "upload" as const,
              name: p.name,
              mime: p.mime,
              dataBase64: "YWJj",
            }
            : p
        ),
      ),
  };
  const owner = createBranchHistory(options);
  owner.select(target);
  return {
    owner,
    options,
    drafts,
    values,
    storage,
    quota: (q: boolean) => {
      quota = q;
    },
    staged: (s: boolean) => {
      staged = s;
    },
    calls: () => calls,
  };
}
Deno.test("legacy saved branches decode message identity without rewriting stored data", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const key = [...f.values.keys()][0];
  const stored = { ...f.owner.state.branches[0], schema: 1 };
  Reflect.set(stored.session, "revert", {
    messageID: "2",
    messageCount: 1,
    files: [],
  });
  const raw = JSON.stringify(stored);
  f.values.set(key, raw);
  const reader = createBranchHistory(f.options);
  reader.select(target);
  assertEquals(reader.state.branches[0].session.revert, {
    boundaryID: "2",
    messageIDs: ["2"],
    files: [],
  });
  assertEquals(f.values.get(key), raw);
});
Deno.test("branch history saves complete retained pages and checkpoints edited draft before commit", async () => {
  const f = fixture();
  f.drafts.writer("server/a")({
    ...emptyDraft(),
    input: "Original",
    variant: undefined,
    editor: { text: "Unsaved editor" },
  });
  await f.owner.prepare(target, "2");
  const saved = f.owner.state.branches[0];
  assertEquals(saved.messages.map((m) => m.id), ["1", "2"]);
  assertEquals(saved.messages[0].source, {
    kind: "fixture",
    preview: "source:1",
    bytes: 8,
    truncated: false,
  });
  assertEquals(f.calls(), 3);
  assertEquals(saved.prompts[0].entry.parts[0], {
    kind: "file",
    source: "upload",
    name: "file.txt",
    mime: "text/plain",
    dataBase64: "YWJj",
  });
  f.staged(true);
  f.drafts.writer("server/a")({ ...emptyDraft(), input: "Replacement" });
  await f.owner.beforeCommit(target);
  assert(
    f.owner.state.branches[0].drafts.some((d) =>
      d.value.input === "Replacement"
    ),
  );
  f.staged(false);
  await f.owner.settled(target);
  assertEquals(f.owner.state.branches[0].replaced, true);
  const reload = createBranchHistory(f.options);
  reload.select(target);
  assertEquals(reload.state.branches.length, 1);
  const original = reload.state.branches[0].drafts[0].value;
  assert(Object.hasOwn(original, "variant"));
  assertEquals(original.variant, undefined);
  assertEquals(original.editor?.text, "Unsaved editor");
  const [key, raw] = [...f.values][0];
  assertEquals(reload.state.branches[0].bytes, 2 * (key.length + raw.length));
});
Deno.test("absent prompt history skips archive acquisition without blocking Revert or submission", async () => {
  const f = fixture();
  const owner = createBranchHistory({
    ...f.options,
    ...{ supportsHistory: () => false },
  });
  owner.select(target);
  await owner.prepare(target, "2");
  f.staged(true);
  await owner.beforeCommit(target);
  await owner.settled(target);
  assertEquals(f.calls(), 0);
  assertEquals(f.values.size, 0);
  assertEquals(owner.state.error, undefined);
  assertEquals(
    owner.preservationWarning(),
    "This branch can't be kept after you send (this server doesn't provide prompt history).",
  );
  owner.select(undefined);
  assertEquals(owner.preservationWarning(), undefined);
});
Deno.test("unavailable persistence mounts without a saved list but visibly refuses committing preservation", async () => {
  const f = fixture(),
    owner = createBranchHistory({ ...f.options, storage: null });
  owner.select(target);
  assertEquals(owner.state.branches, []);
  f.staged(true);
  f.drafts.writer("server/a")({ ...emptyDraft(), input: "Never discarded" });
  await assertRejects(() => owner.beforeCommit(target));
  assertEquals(f.values.size, 0);
  assertEquals(f.calls(), 0);
  const error = owner.state.error;
  assert(error);
  assert(error.failure?.reason.includes("localStorage is unavailable"));
  assertEquals(f.drafts.current("server/a").input, "Never discarded");
});
Deno.test("branch history is keyed by exact server and session and never evicts old branches", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  await f.owner.prepare({ ...target, sessionID: "b" }, "2");
  await f.owner.prepare({ ...target, sidecarId: "other" }, "2");
  assertEquals(f.values.size, 3);
  f.owner.select({ ...target, sessionID: "b" });
  assertEquals(f.owner.state.branches.length, 1);
  f.owner.select(target);
  await f.owner.prepare(target, "2");
  assertEquals(f.owner.state.branches.length, 2);
  assertEquals(f.values.size, 4);
});
Deno.test("a failed advertised prompt-history reader is not a no-history degradation", async () => {
  const f = fixture();
  f.options.prompt = () =>
    Promise.reject(new Error("Exact prompt read failed"));
  await assertRejects(
    () => f.owner.prepare(target, "2"),
    Error,
    "The earlier branch could not be saved",
  );
  assertEquals(f.values.size, 0);
  assertEquals(f.owner.preservationWarning(), undefined);
});
Deno.test("branch history repeated pending revert keeps the complete original capture", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  f.staged(true);
  await f.owner.prepare(target, "1");
  assertEquals(f.calls(), 3);
  assertEquals(f.values.size, 1);
  assertEquals(f.owner.state.branches[0].boundary, "2");
});
Deno.test("branch history quota uses FP1 action target reason recovery and leaves old branches intact", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const original = [...f.values];
  f.staged(true);
  f.drafts.writer("server/a")({ ...emptyDraft(), input: "Not saved" });
  f.quota(true);
  await assertRejects(() => f.owner.beforeCommit(target));
  assertEquals([...f.values], original);
  const failure = f.owner.state.error;
  assert(failure);
  assertEquals(failure.failure?.action, "Saving an earlier branch");
  assertEquals(
    failure.failure?.value.facts?.target?.sessionID,
    target.sessionID,
  );
  assertEquals(failure.failure?.target, { label: "" });
  assert(failure.failure?.reason.includes("not saved"));
  assert(failure.failure?.reason.includes("bytes"));
  assert(failure.failure?.recovery?.includes("Delete a saved branch"));
  assertEquals(f.drafts.current("server/a").input, "Not saved");
});
Deno.test("saved prompt reuse keeps exact text and attachment bytes and offers both drafts", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const branch = f.owner.state.branches[0],
    prompt = savedPromptDraft(branch.prompts[0].entry);
  assertEquals(prompt.input, "Exact\n  prompt 2");
  assertEquals(prompt.chips[0].start, undefined);
  f.drafts.writer("server/a")({ ...emptyDraft(), input: "New draft" });
  f.owner.reuse(branch.id, prompt, "saved prompt");
  assertEquals(f.drafts.current("server/a").input, "New draft");
  assert(f.owner.state.choice);
  assertEquals(f.owner.state.choice.label, "Saved prompt");
  f.drafts.writer("server/a")({ ...emptyDraft(), input: "Even newer draft" });
  f.owner.choose(true);
  assertEquals(f.drafts.current("server/a"), prompt);
  const reload = createBranchHistory(f.options);
  reload.select(target);
  assert(
    reload.state.branches[0].drafts.some((d) => d.value.input === "New draft"),
  );
  assert(
    reload.state.branches[0].drafts.some((d) =>
      d.value.input === "Even newer draft"
    ),
  );
  f.owner.reuse(
    branch.id,
    { ...emptyDraft(), input: "Another" },
    "saved draft",
  );
  f.owner.choose(false);
  assertEquals(f.drafts.current("server/a"), prompt);
});
Deno.test("saved labels have one sentence-case source including existing browser entries", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const key = [...f.values.keys()][0];
  const stored = {
    ...f.owner.state.branches[0],
    schema: 1,
    drafts: f.owner.state.branches[0].drafts.map((d) => ({
      ...d,
      defaultVariant: false,
    })),
  };
  stored.drafts.push({
    label: "saved prompt",
    value: emptyDraft(),
    defaultVariant: false,
  });
  stored.drafts.push({
    label: "saved draft",
    value: emptyDraft(),
    defaultVariant: false,
  });
  f.values.set(key, JSON.stringify(stored));
  const reload = createBranchHistory(f.options);
  reload.select(target);
  assertEquals(reload.state.branches[0].drafts.slice(-2).map((d) => d.label), [
    "Saved prompt",
    "Saved draft",
  ]);
});
Deno.test("branch history explicit delete removes only that saved branch across reload", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const id = f.owner.state.branches[0].id;
  await f.owner.prepare(target, "1");
  f.owner.open(id);
  f.owner.delete(id);
  assertEquals(f.owner.state.opened, undefined);
  assertEquals(f.values.size, 1);
  const reload = createBranchHistory(f.options);
  reload.select(target);
  assertEquals(reload.state.branches.length, 1);
  assert(reload.state.branches[0].id !== id);
});

Deno.test("pending Restore retains edited and original drafts and offers the same saved/current choice", async () => {
  const f = fixture();
  f.drafts.writer("server/a")({ ...emptyDraft(), input: "Original draft" });
  const transaction = f.drafts.reverts.capture("server/a");
  await f.owner.prepare(target, "2");
  transaction.staged("2");
  f.staged(true);
  f.drafts.writer("server/a")({
    ...emptyDraft(),
    input: "Edited after revert",
  });
  await f.owner.beforeCommit(target, "Before restore");
  await f.owner.settled(target, true);
  assertEquals(f.drafts.current("server/a").input, "Edited after revert");
  assertEquals(f.owner.state.choice?.draft.input, "Original draft");
  const reload = createBranchHistory(f.options);
  reload.select(target);
  assert(
    reload.state.branches[0].drafts.some((d) =>
      d.value.input === "Edited after revert"
    ),
  );
  f.owner.choose(true);
  assertEquals(f.drafts.current("server/a").input, "Original draft");
});

Deno.test("post-native archive bookkeeping failure cannot make an admitted send look unsent", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const original = [...f.values];
  f.quota(true);
  await f.owner.settled(target);
  assertEquals([...f.values], original);
  assert(f.owner.state.error);
  assert(
    f.owner.state.error.failure?.reason.includes("native action already ran"),
  );
});

Deno.test("branch capture preserves an invented harness part without assuming it owns NativeSource", async () => {
  const f = fixture(), page = f.options.page;
  f.options.page = async (target, before) => {
    const value = await page(target, before);
    value.items[0].parts.push({
      kind: "branch-fixture",
      id: "third",
      opaque: "Keep this unrelated harness data",
    });
    return value;
  };
  await f.owner.prepare(target, "2");
  assertEquals(f.owner.state.branches[0].messages[0].parts, [{
    kind: "branch-fixture",
    id: "third",
    opaque: "Keep this unrelated harness data",
  }]);
});

Deno.test("explicit Delete fences a late native settlement and cannot resurrect the saved branch", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const id = f.owner.state.branches[0].id;
  const held = Promise.withResolvers<ContentSession>();
  f.options.session = () => held.promise;
  const settling = f.owner.settled(target);
  f.owner.delete(id);
  held.resolve(info());
  await settling;
  assertEquals(f.values.size, 0);
  assertEquals(f.owner.state.branches, []);
  assertEquals(f.owner.state.choice, undefined);
});

for (const phase of ["commit", "settle"] as const) {
  Deno.test(`archive ${phase} merges reuse drafts saved during its held read`, async () => {
    const f = fixture();
    await f.owner.prepare(target, "2");
    const id = f.owner.state.branches[0].id;
    f.staged(true);
    f.drafts.writer("server/a")({
      ...emptyDraft(),
      input: "Captured before wait",
    });
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    if (phase === "commit") {
      const attachments = f.options.attachments;
      f.options.attachments = async (parts) => {
        entered.resolve();
        await gate.promise;
        return attachments(parts);
      };
    } else {
      f.options.session = async () => {
        entered.resolve();
        await gate.promise;
        return info();
      };
    }
    const work = phase === "commit"
      ? f.owner.beforeCommit(target)
      : f.owner.settled(target);
    await entered.promise;
    f.drafts.writer("server/a")({
      ...emptyDraft(),
      input: "Newer current draft",
    });
    f.owner.reuse(
      id,
      { ...emptyDraft(), input: "Explicit saved choice" },
      "Saved draft",
    );
    f.owner.choose(true);
    gate.resolve();
    await work;
    const reload = createBranchHistory(f.options);
    reload.select(target);
    const inputs = reload.state.branches[0].drafts.map((d) => d.value.input);
    assert(inputs.includes("Newer current draft"));
    assert(inputs.includes("Explicit saved choice"));
    if (phase === "commit") assert(inputs.includes("Captured before wait"));
    assertEquals(f.drafts.current("server/a").input, "Explicit saved choice");
    assertEquals(reload.state.branches[0].replaced, phase === "settle");
  });
}
Deno.test("capture decides pending archive membership after the session read settles", async () => {
  const f = fixture();
  await f.owner.prepare(target, "2");
  const first = f.owner.state.branches[0].id, original = f.options.session;
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  let held = true;
  f.options.session = async (t) => {
    if (held) {
      held = false;
      entered.resolve();
      await gate.promise;
    }
    return original(t);
  };
  const work = f.owner.prepare(target, "2");
  await entered.promise;
  await f.owner.settled(target);
  f.staged(true);
  gate.resolve();
  await work;
  const reload = createBranchHistory(f.options);
  reload.select(target);
  assertEquals(reload.state.branches.length, 2);
  assertEquals(
    reload.state.branches.find((b) => b.id === first)?.replaced,
    true,
  );
  assert(reload.state.branches.some((b) => b.id !== first && !b.replaced));
});

Deno.test("archive materialization admits bounded parallel reads within each page and keeps exact order", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>();
  let active = 0, maximum = 0, entered = 0, pages = 0;
  const full = Promise.withResolvers<void>();
  const owner = createBranchHistory({
    ...f.options,
    concurrency: () => 2,
    page: async (t, before) => {
      pages++;
      const result = await f.options.page(t, before);
      result.items = before
        ? [message("1")]
        : Array.from({ length: 10 }, (_, i) => message(String(i + 2)));
      return result;
    },
    source: async (_t, ref) => {
      active++;
      maximum = Math.max(active, maximum);
      if (++entered === 2) full.resolve();
      try {
        await gate.promise;
        return {
          kind: "fixture",
          preview: ref,
          bytes: ref.length,
          truncated: false,
        };
      } finally {
        active--;
      }
    },
  });
  owner.select(target);
  const capture = owner.prepare(target, "2");
  await full.promise;
  assertEquals(
    pages,
    1,
    "No next page until its current materialization finishes",
  );
  assertEquals(
    maximum,
    2,
    "Independent reads overlap without an unbounded flood",
  );
  gate.resolve();
  await capture;
  assertEquals(maximum, 2);
  assertEquals(pages, 3);
  assertEquals(
    owner.state.branches[0].messages.map((m) => m.id),
    Array.from({ length: 11 }, (_, i) => String(i + 1)),
  );
  assertEquals(
    owner.state.branches[0].messages.map((m) => m.source?.preview),
    Array.from({ length: 11 }, (_, i) => `source:${i + 1}`),
  );
});
