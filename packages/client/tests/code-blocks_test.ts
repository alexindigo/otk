// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { FileDiff, Hunk } from "@otk/protocol";
import {
  type CodeBlockSource,
  codeCopyText,
  codeRunAvailability,
  codeRunText,
} from "../code-blocks.ts";

function diff(
  status: FileDiff["status"],
  lines: Hunk["lines"],
): CodeBlockSource {
  const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines };
  const file = { status, additions: 1, deletions: 1, hunks: [hunk] };
  return { kind: "diff", file, hunk };
}

const lines: Hunk["lines"] = [
  { kind: "context", text: "  keep", oldNo: 1, newNo: 1 },
  { kind: "del", text: "old", oldNo: 2 },
  { kind: "add", text: "new", newNo: 2 },
];

Deno.test("Copy uses the exact source for code, commands, requests and output", () => {
  for (const kind of ["fence", "output", "command", "request"] as const) {
    assertEquals(codeCopyText({ kind, text: "a\r\nb\n" }), "a\r\nb\n");
  }
  assertEquals(
    codeCopyText({ kind: "file", text: "source", startLine: 24 }),
    "source",
  );
});

Deno.test("Diff copy uses just the surviving side, without markers or line numbers", () => {
  assertEquals(codeCopyText(diff("modified", lines)), "  keep\nnew");
  assertEquals(codeCopyText(diff("deleted", lines)), "  keep\nold");
  assertEquals(codeCopyText(diff("added", [lines[2]])), "new");
});

Deno.test("Run accepts only shell fences or existing shell tool commands", () => {
  const text = "echo a\r\necho b";
  for (const lang of ["bash", "sh", "shell", "zsh", "BASH"]) {
    assertEquals(
      codeRunText({ kind: "fence", lang, text: text + "\r\n\r" }),
      text,
    );
  }
  for (const lang of ["ts", "python", undefined]) {
    assertEquals(codeRunText({ kind: "fence", lang, text }), undefined);
  }
  assertEquals(codeRunText({ kind: "command", text: "echo a\n" }), "echo a");
  assertEquals(codeRunText({ kind: "command", text: " \r\n\t\r" }), undefined);
  assertEquals(
    codeRunText({ kind: "fence", lang: "sh", text: " \t\n" }),
    undefined,
  );
  for (const kind of ["output", "request"] as const) {
    assertEquals(codeRunText({ kind, text }), undefined);
  }
  assertEquals(
    codeRunText({ kind: "file", lang: "bash", text, startLine: 1 }),
    undefined,
  );
  assertEquals(codeRunText(diff("modified", lines)), undefined);
});

Deno.test("Console Run accepts prompt lines and continuations, not displayed output", () => {
  const run = (text: string) =>
    codeRunText({ kind: "fence", lang: "console", text });
  assertEquals(
    run("$ git status\n M a.ts\n$ git diff --stat\n 1 file changed"),
    "git status\ngit diff --stat",
  );
  assertEquals(run("$ echo a \\\n> b\nout"), "echo a \\\nb");
  assertEquals(run("  $ ls\routput\r\n $ pwd"), "ls\npwd");
  assertEquals(run("output\n> not a continuation"), undefined);
});

Deno.test("Run exposes the reason before invoking its session terminal", () => {
  const source = { kind: "fence", lang: "bash", text: "pwd" } as const;
  assertEquals(
    codeRunAvailability({ source: { ...source, streaming: true } }),
    {
      available: false,
      reason: "This block is still being written",
    },
  );
  assertEquals(codeRunAvailability({ source }), {
    available: false,
    reason: "This block has no session terminal",
  });
  assertEquals(
    codeRunAvailability({
      source,
      sessionID: "session",
      unavailable: "unavailable",
    }),
    {
      available: false,
      reason: "unavailable",
    },
  );
  assertEquals(codeRunAvailability({ source, sessionID: "session" }), {
    available: true,
  });
});
