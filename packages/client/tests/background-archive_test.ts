// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createBranchHistory,
  createDrafts,
  createSessionActions,
  createSessionRevert,
  createState,
  emptyContent,
  emptyDraft,
  type SessionState,
} from "@otk/client";
import type { MessagePage } from "@otk/protocol";
import { shellFixture, shellInfo, shellTask } from "./shell-fixture.ts";

const target = { sidecarId: "local", sessionID: "selected" };
const turns = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function fixture() {
  const f = shellFixture(), values = new Map<string, string>();
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  let staged = false, quota = false;
  const drafts = createDrafts();
  drafts.writer("local/selected")({
    ...emptyDraft(),
    input: "Original unsent draft",
  });
  const session = () => ({
    ...shellInfo("selected"),
    ...(staged
      ? {
        revert: { boundaryID: "boundary", messageIDs: ["boundary"], files: [] },
      }
      : {}),
  });
  const options = {
    drafts,
    feedback: (t: typeof target) =>
      f.resources.sidecars.connection(t.sidecarId).rpc.feedback(t.sessionID),
    storage: {
      get length() {
        return values.size;
      },
      key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (quota) throw new DOMException("full", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
    server: () => "fixture-server",
    session: () => Promise.resolve(session()),
    page: (): Promise<MessagePage> =>
      Promise.resolve({
        sessionID: "selected",
        session: session(),
        items: [{
          id: "boundary",
          sessionID: "selected",
          role: "user",
          time: { created: 1 },
          parts: [],
          source: { kind: "fixture", ref: "exact-source" },
        }],
        clock: { epoch: "archive", seq: 1 },
        from: { epoch: "archive", seq: 1 },
        version: { generation: 1, revision: 1 },
        older: null,
        turns: {},
        helpers: {},
        recovering: [],
        catchup: [],
      }),
    source: async (
      _target: typeof target,
      _ref: string,
      signal?: AbortSignal,
    ) => {
      if (signal) signals.push(signal);
      entered.resolve();
      await held.promise;
      return {
        kind: "fixture",
        preview: "Exact source",
        bytes: 12,
        truncated: false,
      };
    },
    prompt: () =>
      Promise.resolve({
        input: "Exact old prompt",
        mode: "normal" as const,
        parts: [],
        time: 1,
      }),
    attachments: (parts: import("@otk/protocol").PromptPart[]) =>
      Promise.resolve(parts),
  };
  const history = createBranchHistory(options);
  history.select(target);
  const actions = createSessionActions({ ...f, branchHistory: history });
  const live = createState<SessionState>({
    selection: target,
    content: {
      ...emptyContent(),
      messages: [{
        id: "boundary",
        sessionID: "selected",
        role: "user",
        time: { created: 1 },
        parts: [],
      }],
    },
    siblings: [],
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
    clock: { epoch: "initial", seq: 0 },
  });
  const revertOwner = createSessionRevert({
    session: live,
    actions,
    drafts,
    branchHistory: history,
    status: { working: () => false, subscribe: () => () => {} },
  });
  const publish = () =>
    live.update((s) => {
      s.clock = { epoch: staged ? "staged" : "restored", seq: 0 };
      s.content.revert = session().revert ?? null;
      s.content.messages = staged ? [] : [{
        id: "boundary",
        sessionID: "selected",
        role: "user",
        time: { created: 1 },
        parts: [],
      }];
    });
  f.reply((_server, method) => {
    if (method === "session.revert") {
      staged = true;
      publish();
      return Promise.resolve(session());
    }
    if (method === "session.restore") {
      staged = false;
      publish();
      return Promise.resolve(session());
    }
    if (method === "session.get") return Promise.resolve(session());
    if (method === "tasks.create") {
      return Promise.resolve(shellTask("promoted", ["selected"]));
    }
    return Promise.resolve(null);
  });
  return {
    ...f,
    history,
    actions,
    drafts,
    held,
    entered,
    values,
    options,
    signals,
    revert: async () => {
      await revertOwner.revertTo("boundary");
      await revertOwner.confirm();
    },
    stage: () => {
      staged = true;
    },
    quota: () => {
      quota = true;
    },
  };
}

Deno.test("background archive: held save cannot delay reversible Revert, but committing Send joins it", async () => {
  const f = fixture();
  let reverted = false, sent = false;
  const reverting = f.revert().then(() => {
    reverted = true;
  });
  let sending: Promise<unknown> | undefined;
  try {
    await f.entered.promise;
    await turns();
    assert(reverted, "Revert must finish without waiting for the archive save");
    assertEquals(f.values.size, 0);
    sending = f.actions.submission(target)(() => {
      sent = true;
      return Promise.resolve();
    });
    await turns();
    assertEquals(sent, false, "A committing Send must wait for preservation");
    f.held.resolve();
    await sending;
    assert(sent);
    assertEquals(
      f.history.state.branches[0].messages[0].source?.preview,
      "Exact source",
    );
    assertEquals(
      f.history.state.branches[0].prompts[0].entry.input,
      "Exact old prompt",
    );
  } finally {
    f.held.resolve();
    await reverting;
    await sending?.catch(() => {});
    f.resources.stop();
  }
});

Deno.test("background archive: quota failure is FP1-visible before a committing Send can discard history", async () => {
  const f = fixture();
  let reverted = false, sent = false;
  const reverting = f.revert().then(() => {
    reverted = true;
  });
  try {
    await f.entered.promise;
    await turns();
    assert(
      reverted,
      "Quota cannot turn reversible Revert into a save-before-dispatch operation",
    );
    f.quota();
    const sending = f.actions.submission(target)(() => {
      sent = true;
      return Promise.resolve();
    });
    const rejected = assertRejects(() =>
      sending.catch((cause) => {
        assert(
          f.resources.ownsFailure?.(cause),
          "The target sink must own preservation feedback before a command can render its rejection",
        );
        throw cause;
      })
    );
    await turns();
    assertEquals(sent, false);
    f.held.resolve();
    await rejected;
    const feedback = f.history.state.error;
    assert(feedback);
    const failure = feedback.failure;
    assert(failure);
    assertEquals(failure.action, "Saving an earlier branch");
    assertEquals(failure.value.facts?.target?.sessionID, target.sessionID);
    assertEquals(failure.target, { label: "" });
    assert(failure.reason.includes("localStorage is full"));
    assert(failure.recovery?.includes("Delete a saved branch"));
    assertEquals(sent, false, "No silent native commit after archive failure");
    assertEquals(
      f.drafts.current("local/selected").input,
      "Original unsent draft",
    );
  } finally {
    f.held.resolve();
    await reverting;
    f.resources.stop();
  }
});

Deno.test("background archive: Restore cancels stale capture without waiting and preserves both drafts from restored history", async () => {
  const f = fixture();
  try {
    const transaction = f.drafts.reverts.capture("local/selected");
    await f.revert();
    transaction.staged("boundary");
    await f.entered.promise;
    f.drafts.writer("local/selected")({
      ...emptyDraft(),
      input: "Edited after revert",
    });
    await f.actions.restore(target);
    assertEquals(
      f.signals[0].aborted,
      true,
      "Old stage work is retired before Restore returns",
    );
    assertEquals(
      f.values.size,
      0,
      "Restore did not wait for either archive lifetime",
    );
    f.held.resolve();
    await f.history.beforeCommit(target);
    assertEquals(f.values.size, 1, "Only the restored capture may save");
    assertEquals(f.history.state.branches[0].pending, false);
    assertEquals(f.history.state.branches[0].replaced, false);
    assert(
      f.history.state.branches[0].drafts.some((d) =>
        d.value.input === "Original unsent draft"
      ),
    );
    assert(
      f.history.state.branches[0].drafts.some((d) =>
        d.value.input === "Edited after revert"
      ),
    );
    assertEquals(f.history.state.choice?.draft.input, "Original unsent draft");
    assertEquals(f.history.state.error, undefined);
    assertEquals(
      f.drafts.current("local/selected").input,
      "Edited after revert",
    );
  } finally {
    f.held.resolve();
    f.resources.stop();
  }
});

Deno.test("background archive: reloaded staged sessions reacquire preservation before committing", async () => {
  const f = fixture();
  try {
    // A stage from a previous browser lifetime has no in-memory capture here.
    f.stage();
    const reload = createBranchHistory(f.options);
    reload.select(target);
    let admitted = false;
    const sending = reload.beforeCommit(target).then(() => {
      admitted = true;
    });
    await f.entered.promise;
    await turns();
    assertEquals(admitted, false);
    assertEquals(f.values.size, 0);
    f.held.resolve();
    await sending;
    assert(admitted);
    assertEquals(reload.state.branches.length, 1);
    assertEquals(
      reload.state.branches[0].prompts[0].entry.input,
      "Exact old prompt",
    );
  } finally {
    f.held.resolve();
    f.resources.stop();
  }
});

Deno.test("background archive: background failure follows its target across selection before committing", async () => {
  const f = fixture();
  try {
    await f.revert();
    await f.entered.promise;
    f.history.select({ ...target, sessionID: "other" });
    f.quota();
    f.held.resolve();
    await turns();
    assertEquals(f.history.state.error, undefined);
    f.history.select(target);
    assert(f.history.state.error);
    let sent = false;
    await assertRejects(() =>
      f.actions.submission(target)(() => {
        sent = true;
        return Promise.resolve();
      })
    );
    assertEquals(sent, false);
    assert(f.history.state.error);
  } finally {
    f.held.resolve();
    f.resources.stop();
  }
});
