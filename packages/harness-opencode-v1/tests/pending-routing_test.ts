// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type DigestPort, SessionIndex } from "@otk/harness";
import type { ContentOp, SessionMetadata } from "@otk/protocol";
import { OpencodeV1Adapter } from "../adapter.ts";
import { sourceRef } from "../records.ts";
import { cfg } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";
import { waitFor } from "../../../tests/support/opencode.ts";

/** One adapter whose routing metadata is current or unavailable. */
test("V1 storage failure cannot veto permission or question retirement", async () => {
  const f = await routedAdapter(false);
  const saved = new Map<string, string>();
  let full = false;
  f.adapter.storage({
    get: (key) => saved.get(key),
    set: (key, value) => {
      if (full) throw new Error("disk full");
      saved.set(key, value);
    },
    delete: (key) => {
      saved.delete(key);
    },
    scan: ({ prefix, after, limit }) =>
      [...saved].filter(([key]) =>
        key.startsWith(prefix) && (!after || key > after)
      ).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map((
        [key, value],
      ) => ({ key, value })),
    transaction: (run) => run(),
  });
  try {
    f.emit("permission.asked", {
      id: "permission",
      sessionID: "child",
      permission: "bash",
      patterns: [],
      always: [],
      metadata: {},
    });
    f.emit("question.asked", {
      id: "question",
      sessionID: "child",
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
    });
    await waitFor(
      () => f.ops.some((op) => op.op === "question.upsert"),
      Boolean,
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    full = true;
    f.emit("permission.replied", {
      requestID: "permission",
      sessionID: "child",
      reply: "once",
    });
    f.emit("question.rejected", { requestID: "question", sessionID: "child" });
    await waitFor(
      () =>
        f.ops.filter((op) =>
          op.op === "question.remove" || op.op === "permission.remove"
        ).length,
      (count) => count === 2,
    );
    assertEquals(
      await f.adapter.capabilities.permissions!.listPermissions(f.parent.id),
      [],
    );
    assertEquals(f.index.getMetadata(f.child.id)?.attention.questions, 0);
    await waitFor(
      () =>
        f.index.getMetadata(f.child.id)?.attention.errorState?.observations
          .length,
      (count) => count === 2,
    );
    full = false;
    // This fixture deliberately supplies no transcript read; local retry precedes that read.
    await assertRejects(() => f.adapter.core.listMessages(f.child.id, {}));
    assertEquals(
      [...saved.keys()].filter((key) => key.startsWith("records/timeline/"))
        .length,
      2,
    );
    assertEquals(
      f.index.getMetadata(f.child.id)?.attention.errorState?.observations
        .length,
      0,
    );
  } finally {
    await f.adapter.core.stop();
  }
});
test("digest child deletion publishes retirement to the parent's pending projections", async () => {
  const f = await routedAdapter(false);
  try {
    f.emit("permission.asked", {
      id: "permission",
      sessionID: "child",
      permission: "bash",
      patterns: ["printf probe"],
      always: [],
      metadata: {},
    });
    f.emit("question.asked", {
      id: "question",
      sessionID: "child",
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
    });
    await waitFor(
      () => f.ops.some((op) => op.op === "question.upsert"),
      Boolean,
    );
    f.emit("session.deleted", {
      info: {
        id: "child",
        directory: "/project",
        projectID: "p",
        title: "Helper",
        parentID: "parent",
        version: "1.19.3",
        time: { created: 1, updated: 1 },
      },
    });
    await waitFor(
      () =>
        f.ops.filter((op) =>
          op.op === "question.remove" || op.op === "permission.remove"
        ).length,
      (count) => count === 2,
    );
    assertEquals(
      await f.adapter.capabilities.permissions!.listPermissions(f.parent.id),
      [],
    );
    assertEquals(
      f.index.getMetadata(f.parent.id)?.attention.childPermissions,
      0,
    );
  } finally {
    await f.adapter.core.stop();
  }
});
async function routedAdapter(unavailable: boolean) {
  const index = new SessionIndex();
  const parent: SessionMetadata = {
    id: "opcv1-parent",
    directory: "/project",
    projectID: "p",
    title: "Parent",
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const child = {
    ...parent,
    id: "opcv1-child",
    parentID: parent.id,
    title: "Helper",
  };
  const hydrated: string[] = [],
    ops: ContentOp[] = [],
    diagnostics: string[] = [];
  const digest: DigestPort = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    projects: () => Promise.resolve({ projects: [], hints: [] }),
    catalog: () => Promise.reject(new Error("No population catalog")),
    hydrate(ids) {
      if (unavailable) {
        return Promise.reject(new Error("Metadata unavailable"));
      }
      for (const id of ids) {
        hydrated.push(id);
        index.upsertMetadata(id === child.id ? child : parent);
      }
      return Promise.resolve();
    },
    read: ((kind) => {
      if (kind === "supervision.terminals") return Promise.resolve([]);
      // The first question list establishes its directory inventory authority.
      assertEquals(kind, "catalog.questions");
      return Promise.resolve([{
        id: "question",
        sessionID: child.id,
        questions: [{
          header: "Choice",
          text: "Continue?",
          options: [{ label: "Yes", description: "Continue" }],
          multiple: false,
          custom: true,
        }],
      }]);
    }) as DigestPort["read"],
    detail: () => Promise.reject(new Error("No usage demand")),
    transcriptMetadata: () => Promise.reject(new Error("No transcript demand")),
    observe() {},
    scope() {},
    release() {},
    deleted: () => Promise.resolve(),
    deleteIntent: () => Promise.resolve(),
  };
  let stream!: ReadableStreamDefaultController<Uint8Array>, ready = false;
  const adapter = new OpencodeV1Adapter(
    cfg(),
    undefined,
    (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/global/health") {
        return Promise.resolve(Response.json({ version: "1.18.34" }));
      }
      assertEquals(path, "/global/event");
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                ),
              );
              init?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                {
                  once: true,
                },
              );
            },
          }),
        ),
      );
    },
    digest,
    (_level, message) => diagnostics.push(message),
  );
  const emit = (type: string, properties: Record<string, unknown>) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${
          JSON.stringify({
            directory: "/project",
            payload: { type, properties },
          })
        }\n\n`,
      ),
    );
  try {
    await adapter.core.start({
      index,
      connection(state) {
        ready = state === "connected";
      },
      indexReset: (rows) => index.reset(rows),
      indexUpsert: (row) => index.upsertMetadata(row),
      indexRemove: (id) => index.remove(id),
      content: (_id, op) => ops.push(op),
      bootstrapComplete() {},
      invalidate() {},
    });
    await waitFor(() => ready, Boolean);
  } catch (error) {
    await adapter.core.stop();
    throw error;
  }
  return { adapter, emit, ops, index, parent, child, hydrated, diagnostics };
}

for (const unavailable of [false, true]) {
  test(`pending input outside view demand retains ownership with ${unavailable ? "unavailable" : "current"} routing metadata`, async () => {
    const { adapter, emit, ops, index, parent, child, hydrated, diagnostics } =
      await routedAdapter(unavailable);
    try {
      // No session-created event or selected view supplies routing metadata.
      emit("permission.asked", {
        id: "permission",
        sessionID: "child",
        permission: "bash",
        patterns: ["printf probe"],
        always: [],
        metadata: {},
      });
      await waitFor(
        () => ops.some((op) => op.op === "permission.upsert"),
        Boolean,
        1000,
      );
      assertEquals(
        (await adapter.capabilities.permissions!.listPermissions(
          unavailable ? child.id : parent.id,
        )).map((
          p,
        ) => p.id),
        ["permission"],
      );
      assertEquals(
        index.getMetadata(parent.id)?.attention.childPermissions,
        unavailable ? undefined : 1,
      );
      assertEquals(index.getMetadata(child.id)?.attention.permissions, 1);
      emit("question.asked", {
        id: "question",
        sessionID: "child",
        questions: [{
          header: "Choice",
          question: "Continue?",
          options: [{ label: "Yes", description: "Continue" }],
        }],
      });
      await waitFor(
        () => ops.some((op) => op.op === "question.upsert"),
        Boolean,
      );
      assertEquals(
        (await adapter.capabilities.questions!.listQuestions(
          unavailable ? child.id : parent.id,
        )).map((
          q,
        ) => q.id),
        ["question"],
      );
      assertEquals(
        index.getMetadata(parent.id)?.attention.childQuestions,
        unavailable ? undefined : 1,
      );
      assertEquals(index.getMetadata(child.id)?.attention.questions, 1);
      assertEquals(hydrated, unavailable ? [] : [child.id, parent.id]);
      assertEquals(diagnostics, [
        "harness db: using API fallback",
        ...(unavailable
          ? ["pending input routing", "pending input routing"]
          : []),
      ]);
    } finally {
      await adapter.core.stop();
    }
  });

  test(`a question first observed in the directory inventory keeps its text through cancellation with ${unavailable ? "unavailable" : "current"} routing metadata`, async () => {
    const { adapter, emit, ops, parent, child } = await routedAdapter(
      unavailable,
    );
    try {
      // Pending input establishes routing exactly as in the ask-first case.
      emit("permission.asked", {
        id: "permission",
        sessionID: "child",
        permission: "bash",
        patterns: ["printf probe"],
        always: [],
        metadata: {},
      });
      await waitFor(
        () => ops.some((op) => op.op === "permission.upsert"),
        Boolean,
        1000,
      );
      // No raw ask: the directory inventory read by the first question list is
      // this request's first and only observation before it is cancelled.
      assertEquals(
        (await adapter.capabilities.questions!.listQuestions(
          unavailable ? child.id : parent.id,
        )).map((q) => q.id),
        ["question"],
      );
      emit("question.rejected", { sessionID: "child", requestID: "question" });
      await waitFor(
        () => ops.some((op) => op.op === "question.remove"),
        Boolean,
      );
      const exact = await adapter.capabilities.source!.getSource(
        child.id,
        sourceRef({ origin: "record", id: "question:question", path: "" }),
      );
      assert(exact.preview.includes('"text":"Continue?"'), exact.preview);
    } finally {
      await adapter.core.stop();
    }
  });
}
