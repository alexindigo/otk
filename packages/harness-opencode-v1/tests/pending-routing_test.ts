// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type DigestPort, SessionIndex } from "@otk/harness";
import type { ContentOp, SessionMetadata } from "@otk/protocol";
import { OpencodeV1Adapter } from "../adapter.ts";
import { cfg } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";
import { waitFor } from "../../../tests/support/opencode.ts";

for (const unavailable of [false, true]) {
  test(`pending input outside view demand retains ownership with ${unavailable ? "unavailable" : "current"} routing metadata`, async () => {
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
      transcriptMetadata: () =>
        Promise.reject(new Error("No transcript demand")),
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
}
