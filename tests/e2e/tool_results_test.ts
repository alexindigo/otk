// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import {
  legacyStaticMessages,
  visualReply,
} from "../support/legacy-message-scene.ts";
import { highlightedRange } from "../support/highlight.ts";
import type { ToolCall } from "@otk/protocol";
import { revealViewportElement } from "../support/message-viewport.ts";
const base = {
  callID: "result",
  status: "completed" as const,
  awaitingPermission: false,
  time: { start: 1000, end: 2000 },
};
test("typed results show highlighted native file ranges, paths and grep matches without model envelopes or repeated headers, including reload", async () => {
  await legacyStaticMessages("otk-dark", (root) => {
    const path = root + "/src/probe.ts";
    const calls: ToolCall[] = [
      {
        ...base,
        tool: "read",
        path,
        offset: 2,
        limit: 2,
        loaded: [],
        outputContent: {
          kind: "file",
          text: "export const otk_result_marker = 1;\nexport const third = 2;",
          lang: "ts",
          startLine: 2,
          endLine: 3,
          totalLines: 4,
          truncated: true,
        },
      },
      {
        ...base,
        tool: "search",
        mode: "list",
        path: root + "/src",
        matches: 2,
        outputContent: {
          kind: "paths",
          paths: [path],
          offset: 1,
          total: 2,
          truncated: true,
        },
      },
      {
        ...base,
        tool: "search",
        mode: "glob",
        path: root + "/src",
        pattern: "*.ts",
        matches: 1,
        outputContent: { kind: "paths", paths: [path], truncated: false },
      },
      {
        ...base,
        tool: "search",
        mode: "grep",
        path: root + "/src",
        pattern: "otk_result_marker",
        matches: 1,
        outputContent: {
          kind: "matches",
          matches: [{
            path,
            line: 2,
            text: "export const otk_result_marker = 1;",
          }],
          truncated: false,
        },
      },
    ];
    return calls.map((call, i) =>
      visualReply("result-" + i, [{ id: "tool-" + i, kind: "tool", call }], {
        replyTo: "prompt-" + i,
      })
    );
  }, async ({ b, capture }) => {
    for (let i = 0; i < 4; i++) {
      await b.click(`[data-message=result-${i}] .otk-tool-toggle`);
    }
    await revealViewportElement(
      b,
      ".otk-messages",
      "[data-tool=read] .otk-code",
    );
    await highlightedRange(
      b,
      "[data-tool=read] .otk-code[data-language=ts] code",
      "otk_result_marker",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=read] .otk-code-numbers').textContent",
      ),
      "2\n3",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=read] [data-tool-result-meta]').textContent",
      ),
      "2–3 of 4 lines · More available",
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-tool-summary').length"),
      0,
    );
    await capture("typed-file-paths-matches");
  });
});
test("empty result pages retain offset and total without inverted ranges or false empty-file claims", async () => {
  await legacyStaticMessages("otk-dark", () => [visualReply("empty", [
    {
      id: "directory",
      kind: "tool",
      call: {
        ...base,
        tool: "search",
        mode: "list",
        path: "/project/src",
        matches: 1,
        outputContent: {
          kind: "paths",
          paths: [],
          offset: 3,
          total: 1,
          truncated: false,
        },
      },
    },
    {
      id: "file",
      kind: "tool",
      call: {
        ...base,
        tool: "read",
        path: "/project/src/only.txt",
        loaded: [],
        limit: 0,
        outputContent: {
          kind: "file",
          text: "",
          startLine: 1,
          endLine: 0,
          totalLines: 1,
          truncated: true,
        },
      },
    },
  ])], async ({ b, capture }) => {
    for (const tool of ["search", "read"]) {
      await b.click(`[data-tool=${tool}] .otk-tool-toggle`);
    }
    await b.poll(
      "document.querySelector('[data-tool=read] .otk-tool-body')?.textContent.includes('No lines returned')",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=search] .otk-tool-output').textContent",
      ),
      "No results",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=search] [data-tool-result-meta]').textContent",
      ),
      "Offset 3 · 1 entry total",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=read] [data-tool-result-meta]').textContent",
      ),
      "1 line total · More available",
    );
    await capture("empty-results");
  });
});
