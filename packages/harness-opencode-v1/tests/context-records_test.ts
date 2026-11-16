// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { isRealPrompt, sourceAt } from "@otk/protocol";
import { deriveMessage, derivePart, mapMessage, mapPart } from "../map.ts";
import { reachable } from "./source-support.ts";
import type { Info, RawPart } from "../types.ts";
import { ContentReplay } from "@otk/harness";
import { StreamBuffers } from "@otk/content";
import { Transcript } from "../transcript.ts";
import { Client } from "../client.ts";
import { Messages, type NativeMessage } from "../messages.ts";
import { cfg } from "../../../tests/support/config.ts";
import { V1RecordRetention } from "../record-retention.ts";
import { eventRecord, parseSourceRef } from "../records.ts";
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
Deno.test("Source proof rejects a reachable path with the wrong native owner", () => {
  const raw = text(true), loaded = mapPart(raw), derived = derivePart(raw);
  assertThrows(() =>
    reachable(loaded, derived, { origin: "message", id: "wrong-owner" })
  );
  assertThrows(() =>
    reachable(loaded, derived, { origin: "record", id: raw.messageID })
  );
  assert(
    reachable(loaded, derived, { origin: "message", id: raw.messageID }).preview
      .includes("kept"),
  );
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
    const raw = {
      ...text(false),
      type,
      snapshot: "sha",
      hash: "h",
      files: ["a.ts"],
      reason: "stop",
    };
    const part = mapPart(raw);
    assert(part.kind === "external");
    assert(part.activity);
    // Bookkeeping is not copy content: only its reference is loaded.
    assertEquals(part.source?.payload, undefined);
    assert(
      reachable(part, derivePart(raw), { origin: "message", id: raw.messageID })
        .preview.includes('"hash":"h"'),
    );
    assertEquals(part.name, `opencode-v1/${type}`);
    assertEquals(part.content, undefined);
  }
  const large = {
    ...text(false),
    type: "future-record",
    text: "x".repeat(70_000),
  };
  const part = mapPart(large);
  assert(part.kind === "external");
  const view = reachable(part, derivePart(large), {
    origin: "message",
    id: large.messageID,
  });
  assertEquals(view.truncated, true);
  assert(view.bytes > 70_000);
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
  const envelopeParts = [{ ...text(true), text: envelope }];
  const result = mapMessage(info, envelopeParts);
  assertEquals(result.role, "context");
  assert(
    reachable(result, deriveMessage(info, envelopeParts), {
      origin: "message",
      id: info.id,
    }).preview.includes(
      '"id":"m"',
    ),
  );
  const row = result.parts[0];
  assert(row.kind === "external");
  // Declared content keeps its exact text for Copy.
  assertEquals(row.source?.payload, envelope);
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

Deno.test("V1 malformed task envelopes preserve complete outgoing context without breaking record mapping", () => {
  for (
    const child of ["child/path", "child name", "opcv1-child", "child.example"]
  ) {
    const envelope =
      `<task id="${child}" state="completed">\n<task_result>\nDone\n</task_result>\n</task>`;
    const parts = [{ ...text(true), text: envelope }];
    const message = mapMessage(info, parts),
      derived = deriveMessage(info, parts);
    assertEquals(message.role, "context");
    assertEquals(parseSourceRef(message.source!.ref!), {
      origin: "message",
      id: info.id,
      path: "",
    });
    assertEquals(
      JSON.parse(
        reachable(message, derived, { origin: "message", id: info.id }).preview,
      ),
      info,
    );
    assertEquals(derived.source?.payload, envelope);
    const part = message.parts[0];
    assert(part.kind === "external");
    assertEquals(part.activity?.child, undefined);
    assertEquals(part.activity?.direction, "outgoing");
    assertEquals(part.source?.payload, envelope);
  }
});

Deno.test("V1 malformed optional child metadata preserves task and unknown tool results without a link", () => {
  for (
    const child of ["child/path", "child name", "opcv1-child", "child.example"]
  ) {
    const envelope =
      `<task id="${child}" state="completed">\n<task_result>\nDone\n</task_result>\n</task>`;
    for (const tool of ["task", "future-tool"]) {
      const raw: RawPart = {
        ...text(false),
        type: "tool",
        tool,
        callID: "call",
        state: {
          status: "completed",
          input: {},
          output: envelope,
          metadata: { sessionId: child },
        },
      };
      const mapped = mapPart(raw);
      assert(mapped.kind === "tool");
      assertEquals(
        "childSessionID" in mapped.call
          ? mapped.call.childSessionID
          : undefined,
        undefined,
      );
      assertEquals(mapped.call.output, envelope);
      const derived = derivePart(raw);
      assert(derived.kind === "tool");
      const ref = parseSourceRef(mapped.call.source!.ref!);
      assertEquals(ref, {
        origin: "message",
        id: raw.messageID,
        path: `p:${raw.id}/c`,
      });
      const view = sourceAt(derived, ref.path);
      assert(view);
      assertEquals(JSON.parse(view.preview).state.output, envelope);
      assertEquals(derived.call.source?.payload, envelope);
      assertEquals(mapped.call.outputContent, undefined);
    }
  }
});

Deno.test("V1 malformed task output is not accepted as a decoded task envelope", () => {
  const envelope =
    `<task id="child/path" state="completed">\n<task_result>\nDone\n</task_result>\n</task>`;
  const mapped = mapPart({
    ...text(false),
    type: "tool",
    tool: "task",
    callID: "call",
    state: { status: "completed", input: {}, output: envelope },
  });
  assert(mapped.kind === "tool");
  assertEquals(mapped.call.outputContent, undefined);
  assertEquals(mapped.call.output, envelope);
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
  assertEquals(changed.part.description, "Inspect records");
  assertEquals(changed.message.info, info);
  assertEquals(
    changed.message.parts.find((part) => part.id === "subtask"),
    changed.part,
  );
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
