// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  checkClientFrameSize,
  frecency,
  type HistoryEntry,
  isAttentionOp,
  isPermissionOp,
  MAX_CLIENT_FRAME_BYTES,
  mergeHistory,
  sameParts,
  sessionErrorMessage,
} from "../mod.ts";

Deno.test("frame budget checks UTF-8 bytes as well as string length", () => {
  assertEquals(MAX_CLIENT_FRAME_BYTES, 64 * 1024 * 1024);
  checkClientFrameSize(' {"t":"pong"} ');
  checkClientFrameSize("a".repeat(MAX_CLIENT_FRAME_BYTES - 1));
  assertThrows(
    () => checkClientFrameSize("a".repeat(MAX_CLIENT_FRAME_BYTES)),
    Error,
    "64 MiB",
  );
  assertThrows(
    () => checkClientFrameSize("é".repeat(MAX_CLIENT_FRAME_BYTES / 2)),
    Error,
    "64 MiB",
  );
});
Deno.test("content attention classification separates permission and question operations", () => {
  const permission = {
    op: "permission.remove",
    requestID: "p",
    sessionID: "s",
  } as const;
  const question = {
    op: "question.remove",
    requestID: "q",
    sessionID: "s",
  } as const;
  assertEquals(isPermissionOp(permission), true);
  assertEquals(isAttentionOp(permission), true);
  assertEquals(isPermissionOp(question), false);
  assertEquals(isAttentionOp(question), true);
  assertEquals(isAttentionOp({ op: "todo.set", items: [] }), false);
});
Deno.test("history merge keeps newest adjacent duplicates and limits to fifty", () => {
  const entries: HistoryEntry[] = Array.from({ length: 60 }, (_, time) => ({
    input: `prompt ${time}`,
    mode: "normal",
    parts: [{ kind: "text", text: `prompt ${time}` }],
    time,
  }));
  const merged = mergeHistory([entries, [{ ...entries[59], time: 60 }]]);
  assertEquals(merged.length, 50);
  assertEquals([merged[0].input, merged[0].time, merged.at(-1)!.input], [
    "prompt 59",
    60,
    "prompt 10",
  ]);
  assertEquals(
    sameParts([{
      kind: "file",
      source: "path",
      path: "a",
      range: { start: 1 },
    }], [{ kind: "file", source: "path", path: "a", range: { start: 2 } }]),
    false,
  );
  assertEquals(
    sameParts([{ kind: "agent", name: "build" }], [{
      kind: "agent",
      name: "build",
    }]),
    true,
  );
});
Deno.test("error selection preserves event priority, current HTTP ownership and cleared state", () => {
  const state = {
    revision: 1,
    currentRequestID: "current",
    observations: [
      {
        id: "old",
        source: "http" as const,
        requestID: "old",
        message: "old error",
      },
      {
        id: "current",
        source: "http" as const,
        requestID: "current",
        message: "current error",
      },
      { id: "event", source: "event" as const, message: "native error" },
    ],
  };
  assertEquals(sessionErrorMessage(state), "native error");
  assertEquals(
    sessionErrorMessage({
      ...state,
      observations: state.observations.slice(0, 2),
    }),
    "current error",
  );
  assertEquals(
    sessionErrorMessage({
      ...state,
      observations: state.observations.slice(0, 1),
    }),
    "An earlier request failed.",
  );
  assertEquals(
    sessionErrorMessage({
      ...state,
      observations: state.observations.map((item) => ({
        ...item,
        cleared: true,
      })),
    }),
    undefined,
  );
});
Deno.test("frecency preserves daily decay without penalizing future or missing entries", () => {
  assertEquals(frecency(undefined, 0), 0);
  assertEquals(frecency({ path: "x", score: 4, last: 0 }, 86_400_000), 2);
  assertEquals(frecency({ path: "x", score: 4, last: 100 }, 0), 4);
});
