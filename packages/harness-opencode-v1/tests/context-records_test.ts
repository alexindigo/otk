// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { isRealPrompt } from "@otk/protocol";
import { mapMessage, mapPart } from "../map.ts";
import type { Info, RawPart } from "../types.ts";
import { ContentReplay } from "@otk/harness";
import { StreamBuffers } from "@otk/content";
import { Transcript } from "../transcript.ts";
import { Client } from "../client.ts";
import { Messages, type NativeMessage } from "../messages.ts";
import { cfg } from "../../../tests/support/config.ts";
import { V1RecordRetention } from "../record-retention.ts";
import { eventRecord } from "../records.ts";
import { RecordProjection } from "../records.ts";
const info: Info = {
  id: "m",
  sessionID: "s",
  role: "user",
  time: { created: 1 },
  agent: "build",
};
const text = (synthetic: boolean): RawPart => ({
  id: synthetic ? "context" : "prompt",
  messageID: "m",
  sessionID: "s",
  type: "text",
  text: "**kept**",
  synthetic,
});
Deno.test("V1 content establishes prompt identity; synthetic-only and empty headers never anchor", () => {
  assertEquals(isRealPrompt(mapMessage(info)), false);
  const context = mapMessage(info, [text(true)]);
  assertEquals(context.role, "context");
  assertEquals(isRealPrompt(context), false);
  const mixed = mapMessage(info, [text(false), text(true)]);
  assertEquals(isRealPrompt(mixed), true);
  assertEquals(mixed.parts.length, 2);
  const part = mixed.parts[1];
  assert(part.kind === "external");
  assertEquals(part.id, "context");
  assertEquals(part.activity?.direction, "outgoing");
  assertEquals(part.activity?.category, "outgoing");
  assertEquals(part.source?.payload, "**kept**");
  // The exact sent text is declared message content; bookkeeping is not.
  assertEquals(part.content, true);
  for (const type of ["file", "agent"]) {
    assert(isRealPrompt(mapMessage(info, [{ ...text(true), type }])));
  }
});
Deno.test("V1 maps every native bookkeeping, delegation, retry and unknown identity visibly with source", () => {
  for (
    const type of [
      "snapshot",
      "patch",
      "retry",
      "subtask",
      "compaction",
      "step-start",
      "step-finish",
      "future-record",
    ]
  ) {
    const part = mapPart({
      ...text(false),
      type,
      snapshot: "sha",
      hash: "h",
      files: ["a.ts"],
      reason: "stop",
    });
    assert(part.kind === "external");
    assert(part.activity);
    assert(part.source?.payload?.includes('"hash":"h"'));
    assertEquals(part.name, `opencode-v1/${type}`);
    assertEquals(part.content, undefined);
  }
  const part = mapPart({
    ...text(false),
    type: "future-record",
    text: "x".repeat(70_000),
  });
  assert(part.kind === "external");
  assertEquals(part.source?.truncated, true);
  assertEquals(JSON.parse(part.source!.payload!).text.length, 70_000);
});
Deno.test("V1 summary and interruption remain source-linked context boundaries", () => {
  const assistant: Info = {
    ...info,
    role: "assistant",
    agent: "compaction",
    parentID: "marker",
    summary: true,
    time: { created: 2, completed: 3 },
  };
  const summary = mapMessage(assistant, [text(false)]);
  assertEquals(summary.role, "context");
  const boundary = summary.parts.find((part) => part.kind === "external");
  assert(boundary?.kind === "external");
  assertEquals(boundary.activity?.layout, "boundary");
  assertEquals(boundary.activity?.title, "Session compacted");
  assert(boundary.activity?.body?.length);
  assert(boundary.activity?.parameters?.some((p) => p.value === "marker"));
  // A finished summary is terminal; a running one is active work.
  assertEquals(boundary.activity?.state?.facts, {
    active: false,
    terminal: true,
  });
  const running = mapMessage({ ...assistant, time: { created: 2 } }, [
    text(false),
  ]).parts.find((part) => part.kind === "external");
  assert(running?.kind === "external");
  assertEquals(running.activity?.state?.key, "running");
  assertEquals(running.activity?.state?.facts.active, true);
  const aborted = mapMessage({
    ...assistant,
    summary: false,
    error: {
      name: "MessageAbortedError",
      data: { message: "Stopped by user" },
    },
  });
  assert(
    aborted.parts.some((part) =>
      part.kind === "external" && part.activity?.title === "Interrupted"
    ),
  );
});

Deno.test("V1 request outcomes summarize native or inventory request facts, never internal identities", () => {
  const detail = (type: string, request?: Record<string, unknown>) => {
    const part = eventRecord("s", "retained", 1, type, {
      requestID: "retained",
      reply: "reject",
    }, request).parts[0];
    assert(part.kind === "external");
    return part.activity?.detail;
  };
  assertEquals(
    detail("permission.replied", {
      permission: "bash",
      patterns: ["*"],
      metadata: { command: "git status --short" },
    }),
    "bash: git status --short",
  );
  assertEquals(
    detail("permission.replied", {
      kind: "bash",
      detail: { kind: "bash", command: "git diff" },
    }),
    "bash: git diff",
  );
  assertEquals(
    detail("permission.replied", {
      permission: "edit",
      patterns: ["src/main.ts"],
    }),
    "edit: src/main.ts",
  );
  assertEquals(
    detail("question.rejected", {
      questions: [{
        header: "Verification",
        question: "Run the focused checks?",
      }],
    }),
    "Verification: Run the focused checks?",
  );
  assertEquals(
    detail("question.rejected", { questions: [{ question: "Continue?" }] }),
    "Continue?",
  );
  assertEquals(detail("permission.replied"), "Permission request");
  assertEquals(detail("question.rejected"), "Question");
});
Deno.test("V1 failed task result and independent assistant failure retain both error texts", () => {
  const error = "The usage limit has been reached";
  const envelope =
    `<task id="child" state="error">\n<summary>Background task failed: investigate</summary>\n<task_error>\n${error}\n</task_error>\n</task>`;
  const result = mapMessage(info, [{
    ...text(true),
    text: envelope,
  }]);
  assertEquals(result.role, "context");
  assertEquals(result.source?.payload, envelope);
  const row = result.parts[0];
  assert(row.kind === "external");
  assertEquals(row.activity?.tone, "error");
  assertEquals(row.activity?.child?.sessionID, "opcv1-child");
  assert(JSON.stringify(row.activity?.body).includes(error));
  const failure = mapMessage({
    ...info,
    role: "assistant",
    agent: "build",
    error: { name: "APIError", data: { message: error } },
  });
  assert(failure.role === "assistant");
  assertEquals(failure.error?.message, error);
});

Deno.test("V1 retained outcomes compose with native history in ten-row pages without omission or duplication", async () => {
  const settings = cfg(), retained = new V1RecordRetention();
  for (let i = 13; i <= 32; i++) {
    const id = `question:${i % 2 ? "A" : "a"}${i}`;
    retained.put({
      id,
      sessionID: "opcv1-s",
      created: 13,
      message: eventRecord("s", id, 13, "question.rejected", {
        requestID: `q${i}`,
      }),
    });
  }
  const native: NativeMessage[] = Array.from({ length: 12 }, (_, index) => ({
    info: { ...info, id: `m${index + 1}`, time: { created: index + 1 } },
    parts: [{
      ...text(false),
      id: `p${index + 1}`,
      messageID: `m${index + 1}`,
    }],
  }));
  const reader = new Messages(
    new Client(
      settings.harness,
      () => Promise.reject(new Error("unexpected HTTP")),
    ),
    () => "/p",
  );
  reader.page = (_id, limit, before) => {
    assertEquals(limit, 10);
    return Promise.resolve(
      before
        ? { items: native.slice(0, 2) }
        : { items: native.slice(2), next: "older" },
    );
  };
  const transcript = new Transcript({
    replay: new ContentReplay({
      ...settings.messages,
      nonce: () => "epoch",
      emit() {},
    }),
    buffers: new StreamBuffers(),
    reader,
    raw: () =>
      Promise.resolve({
        id: "s",
        projectID: "p",
        directory: "/p",
        title: "S",
        time: { created: 1, updated: 32 },
      }),
    info: () =>
      Promise.resolve({
        id: "opcv1-s",
        projectID: "p",
        directory: "/p",
        title: "S",
        time: { created: 1, updated: 32 },
        archived: false,
      }),
    decorate: (message) => message,
    summaries: () => ({}),
    metadata: () => Promise.resolve({ boundaries: [], prompt: { id: "m12" } }),
    retained: (id, before, limit) => retained.page(id, before, limit),
  });
  const all: string[] = [];
  let before: string | undefined;
  do {
    const page = await transcript.page("opcv1-s", before);
    assert(page.items.length <= 10);
    all.push(...page.items.map((message) => message.id));
    before = page.older ?? undefined;
    assert(all.length <= 32, "pagination must advance");
  } while (before);
  assertEquals(all.length, 32);
  assertEquals(new Set(all).size, 32);
  transcript.release();
  // Retained-only visible pages must not displace the native prompt anchor in
  // independently composed adapters without the application's metadata worker.
  const standaloneReader = new Messages(reader.client, () => "/p");
  standaloneReader.page = (_id, limit) => {
    assertEquals(limit, 10);
    return Promise.resolve({ items: native.slice(2) });
  };
  const standalone = new Transcript({
    ...transcript.options,
    reader: standaloneReader,
    metadata: undefined,
  });
  try {
    const page = await standalone.page("opcv1-s");
    assert(page.items.every((row) => row.role === "context"));
    assertEquals(page.prompt?.id, "m12");
  } finally {
    standalone.release();
  }
});

Deno.test("V1 record projection classifies header-before-parts and retains non-text deltas by part identity", () => {
  const projection = new RecordProjection({
    replayops: 128,
    replaybytes: 100000,
  });
  assertEquals(isRealPrompt(mapMessage(projection.header(info).info)), false);
  projection.part(text(true));
  const mixed = projection.part(text(false))!;
  assert(isRealPrompt(mapMessage(mixed.info, mixed.parts)));
  projection.part({
    ...text(false),
    id: "subtask",
    type: "subtask",
    description: "Inspect",
  });
  const changed = projection.delta(
    "s",
    "m",
    "subtask",
    "description",
    " records",
  )!;
  assertEquals(changed.description, "Inspect records");
  assertEquals(
    projection.delta("s", "m", "subtask", "unknown", "x"),
    undefined,
  );
  assertEquals(
    projection.remove("s", "m", "prompt")?.parts.some((part) =>
      part.id === "prompt"
    ),
    false,
  );
  assertEquals(
    isRealPrompt(mapMessage(info, projection.get("s", "m")!.parts)),
    false,
  );
  projection.release("s");
  assertEquals(projection.get("s", "m"), undefined);
});
