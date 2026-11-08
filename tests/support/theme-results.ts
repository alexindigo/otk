// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, Part, ToolCall } from "@otk/protocol";
import { mapDiffs, mapTool, type RawPart } from "@otk/harness-opencode-v1";

/** The original typed-result and project-path witnesses, without a backend boot. */
export function themeResults(directory: string, sessionID: string) {
  const base = {
    callID: "result",
    status: "completed" as const,
    time: { start: 1000, end: 2000 },
  };
  const reply = (id: string, parts: Part[]): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "prompt-" + id,
    agent: "build",
    model: { provider: "fake", model: "scripted" },
    time: { created: 2000, completed: 6000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts,
  });
  const path = directory + "/src/probe.ts";
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
      path: directory + "/src",
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
      path: directory + "/src",
      pattern: "*.ts",
      matches: 1,
      outputContent: { kind: "paths", paths: [path], truncated: false },
    },
    {
      ...base,
      tool: "search",
      mode: "grep",
      path: directory + "/src",
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
  const typed = calls.map((call, i) =>
    reply("result-" + i, [{ id: "tool-" + i, kind: "tool", call }])
  );
  const empty = [reply("empty", [
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
  ])];
  const paths: AssistantMessage[] = [];
  for (const outside of [false, true]) {
    const dir = outside ? "/outside" : directory + "/src";
    for (const mode of ["read", "list", "glob"] as const) {
      const id = `${outside}-${mode}`;
      paths.push(reply(id, [{
        id,
        kind: "tool",
        call: mode === "read"
          ? {
            ...base,
            callID: id,
            tool: "read",
            path: dir + "/probe.txt",
            loaded: outside ? [] : [directory + "/src/AGENTS.md"],
            outputContent: {
              kind: "file",
              text: outside ? "outside marker" : "path marker",
              startLine: 1,
              endLine: 1,
              totalLines: 1,
              truncated: false,
            },
          }
          : {
            ...base,
            callID: id,
            tool: "search",
            mode,
            path: dir,
            matches: 1,
            outputContent: {
              kind: "paths",
              paths: [dir + "/probe.txt"],
              truncated: false,
            },
          },
      }]));
    }
  }
  paths.push(
    reply("cwd", [{
      id: "cwd",
      kind: "tool",
      call: {
        ...base,
        callID: "cwd",
        tool: "bash",
        command: "pwd",
        cwd: directory + "/src",
        output: directory + "/src",
      },
    }]),
  );
  const raw = (
    id: string,
    tool: string,
    output?: string,
    metadata: Record<string, unknown> = {},
  ): RawPart => ({
    id,
    sessionID: "native",
    messageID: "reply",
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      metadata,
      time: { start: 1000, end: 2000 },
    },
  });
  const metadata = [reply("metadata", [
    {
      id: "unknown-search",
      kind: "tool",
      call: mapTool(raw("unknown-search", "grep")),
    },
    {
      id: "zero-search",
      kind: "tool",
      call: mapTool(raw("zero-search", "grep", undefined, { matches: 0 })),
    },
    {
      id: "unknown-diff",
      kind: "tool",
      call: {
        ...base,
        tool: "patch",
        files: mapDiffs([{ additions: 0, deletions: 0 }]),
      },
    },
    {
      id: "plain-output",
      kind: "tool",
      call: mapTool(
        raw(
          "plain-output",
          "external",
          Array.from({ length: 15 }, (_, i) => `Output line ${i + 1}`).join(
            "\n",
          ),
        ),
      ),
    },
  ])];
  const facts = [{
    ...reply("facts", [
      {
        id: "task",
        kind: "tool",
        call: {
          ...base,
          tool: "task",
          description: "Inspect the result",
          progress: { state: "unavailable", revision: 0, toolCount: null },
          childSessionID: "tstv1-child",
        },
      },
      {
        id: "external",
        kind: "tool",
        call: {
          ...base,
          tool: "external",
          name: "external-preview",
          summary: "A backend-owned preview",
          output: "A short preview from another backend.",
          outputTruncated: true,
        },
      },
    ]),
    agent: "action",
    agentColor: "accent" as const,
  }];
  return { typed, "empty-results": empty, paths, metadata, facts };
}
