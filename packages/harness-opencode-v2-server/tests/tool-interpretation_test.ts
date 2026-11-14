// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue } from "@otk/protocol";
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  interpretTool,
  mapTool,
  toolProgress,
  toolScalarSQL,
} from "../tool-interpretation.ts";
import { Messages, type NativeMessage } from "../messages.ts";
import { TranscriptReads } from "../transcript-reads.ts";
import { mapTool as v1Tool, type RawPart } from "@otk/harness-opencode-v1";

type Tool = Extract<NativeMessage, { type: "assistant" }>["content"][number] & {
  type: "tool";
};
const tool = (
  name: string,
  input: Exclude<Tool["state"]["input"], string>,
  metadata = {},
  output = "ok",
): Tool => ({
  type: "tool",
  id: "call",
  name,
  time: { created: 1, completed: 2 },
  state: {
    status: "completed",
    input,
    metadata,
    content: [{ type: "text", text: output }],
  },
});
for (
  const [legacy, current, oldInput, newInput] of [
    ["read", "read", { filePath: "/a.ts", offset: 190, limit: 50 }, {
      path: "/a.ts",
      offset: 190,
      limit: 50,
    }],
    ["bash", "shell", { command: "pwd", workdir: "/repo" }, {
      command: "pwd",
      workdir: "/repo",
    }],
    ["task", "subagent", { subagent_type: "junior", description: "Inspect" }, {
      agent: "junior",
      description: "Inspect",
    }],
    ["edit", "edit", { filePath: "/a.ts" }, { path: "/a.ts" }],
    ["write", "write", { filePath: "/a.ts", content: "new" }, {
      path: "/a.ts",
      content: "new",
    }],
    ["skill", "skill", { name: "review" }, { id: "review" }],
    ["apply_patch", "patch", { patchText: "patch" }, { patchText: "patch" }],
  ] as const
) {
  Deno.test(`tool dialects ${legacy}/${current} yield equivalent typed targets`, () => {
    const a = mapTool(tool(legacy, oldInput)),
      b = mapTool(tool(current, newInput));
    assertEquals({ ...a, sourceName: "same" }, { ...b, sourceName: "same" });
    assertEquals(a.sourceName, legacy);
    const old = v1Tool(
      {
        type: "tool",
        id: "part",
        sessionID: "ses_fixture",
        messageID: "msg",
        callID: "call",
        tool: legacy,
        state: {
          status: "completed",
          input: oldInput,
          metadata: {},
          output: "ok",
          time: { start: 1, end: 2 },
          title: "",
        },
      } as RawPart,
    );
    assertEquals(old.tool, a.tool);
    if ("path" in a && "path" in old) assertEquals(a.path, old.path);
    if (a.tool === "task" && old.tool === "task") {
      assertEquals(a.agent, old.agent);
    }
    if (a.tool === "bash" && old.tool === "bash") assertEquals(a.cwd, old.cwd);
  });
}
Deno.test("current documented fields win hybrids, malformed fields use historical strings", () => {
  const value = interpretTool("subagent", {
    path: "/current",
    filePath: "/old",
    workdir: "/work",
    cwd: "/cwd",
    agent: "current",
    subagent_type: "old",
    sessionID: "new",
    task_id: "old",
  }, { sessionID: "current", sessionId: "old" });
  assertEquals([
    value.input.path,
    value.input.cwd,
    value.input.agent,
    value.input.sessionID,
    value.child,
  ], ["/current", "/work", "current", "new", "current"]);
  assertEquals(
    interpretTool("read", { path: 7, filePath: "/old" }, {}).input.path,
    "/old",
  );
  assertEquals(interpretTool("constructor", {}, {}).name, "constructor");
});
Deno.test("legacy read wrappers decode only coherent bodies and retain raw output", () => {
  const output =
    "<path>/a.ts</path>\n<type>file</type>\n<content>\n1: old\n\n(End of file - total 1 lines)\n</content>";
  const call = mapTool(tool("read", { filePath: "/a.ts" }, {}, output));
  assertEquals(call.output, output);
  assertEquals(call.outputContent, {
    kind: "file",
    text: "old",
    lang: "ts",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    truncated: false,
  });
  assertEquals(
    mapTool(
      tool(
        "read",
        { path: "/a.ts" },
        {},
        output.replace("1: old", "1: old\n3: skipped"),
      ),
    ).outputContent,
    { kind: "text", text: output.replace("1: old", "1: old\n3: skipped") },
  );
  assertEquals(
    mapTool(tool("read", {}, {}, output.replace("1: old", "bad")))
      .outputContent,
    { kind: "text", text: output.replace("1: old", "bad") },
  );
  const directory =
    "<path>/repo</path>\n<type>directory</type>\n<entries>\na.ts\nlib/\n\n(2 entries)\n</entries>";
  const listed = mapTool(
    tool("read", { filePath: "/repo" }, {
      display: {
        type: "directory",
        path: "/repo",
        entries: ["a.ts", "lib/"],
        offset: 1,
        totalEntries: 2,
        truncated: false,
      },
    }, directory),
  );
  assert(listed.tool === "search");
  assertEquals(listed.outputContent, {
    kind: "paths",
    paths: ["/repo/a.ts", "/repo/lib/"],
    offset: 1,
    total: 2,
    truncated: false,
  });
});
Deno.test("legacy read projections retain truncation from every native evidence source", () => {
  const file =
    "<path>/a.ts</path>\n<type>file</type>\n<content>\n1: old\n\n(End of file - total 1 lines)\n</content>";
  const directory =
    "<path>/repo</path>\n<type>directory</type>\n<entries>\na.ts\n\n(1 entries)\n</entries>";
  for (const truncated of [false, true]) {
    const read = mapTool(
      tool("read", { filePath: "/a.ts" }, { truncated }, file),
    );
    assert(read.outputContent?.kind === "file");
    assertEquals(read.outputContent.truncated, truncated);
    assertEquals(read.output, file);
    for (const displayTruncated of [false, true]) {
      const listed = mapTool(tool("read", { filePath: "/repo" }, {
        truncated,
        display: {
          type: "directory",
          path: "/repo",
          entries: ["a.ts"],
          offset: 1,
          totalEntries: 1,
          truncated: displayTruncated,
        },
      }, directory));
      assert(listed.outputContent?.kind === "paths");
      assertEquals(
        listed.outputContent.truncated,
        truncated || displayTruncated,
      );
      assertEquals(listed.output, directory);
    }
  }
});
Deno.test("legacy patch metadata and current metadata preserve the same diff", () => {
  const patch = "--- /a.ts\n+++ /a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const a = mapTool(
    tool("apply_patch", {}, {
      files: [{ filePath: "/a.ts", type: "update", patch }],
    }),
  );
  const b = mapTool(
    tool("patch", {}, {
      files: [{ file: "/a.ts", status: "modified", patch }],
    }),
  );
  assert(a.tool === "patch" && b.tool === "patch");
  assertEquals(a.files, b.files);
});
Deno.test("historical search, skill and task envelopes use the same result decoder", () => {
  const grep = mapTool(
    tool(
      "grep",
      {},
      {},
      "Found 1 matches (more matches available)\n/a.ts:\n  Line 7: match\n\n(Results truncated. Consider using a more specific path or pattern.)",
    ),
  );
  assertEquals(grep.outputContent, {
    kind: "matches",
    matches: [{ path: "/a.ts", line: 7, text: "match" }],
    truncated: true,
  });
  assertEquals(
    mapTool(tool("list", { filePath: "/repo" }, {}, "/repo/a.ts\n/repo/b.ts"))
      .outputContent,
    { kind: "paths", paths: ["/repo/a.ts", "/repo/b.ts"], truncated: false },
  );
  const task =
    '<task id="ses_child" state="completed">\n<summary>Inspect</summary>\n<task_result>\n**Done**\n</task_result>\n</task>';
  assertEquals(mapTool(tool("task", {}, {}, task)).outputContent, {
    kind: "text",
    text: "**Done**",
  });
  const skill =
    '<skill_content name="review">\n# Skill: review\n\nInspect changes\n\nBase directory for this skill: /skills/review\nRelative paths in this skill are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file>/skills/review/info.md</file>\n</skill_files>\n</skill_content>';
  assertEquals(
    mapTool(tool("skill", { name: "review" }, {}, skill)).outputContent,
    {
      kind: "skill",
      text: "Inspect changes",
      directory: "/skills/review",
      paths: ["/skills/review/info.md"],
    },
  );
});
Deno.test("usage and helper labels keep the command distinct from the tool description", () => {
  const value = interpretTool("shell", {
    command: "pwd",
    description: "Read the directory",
    workdir: "/repo",
  }, {});
  assertEquals(value.sourceName, "shell");
  assertEquals(value.name, "bash");
  assertEquals(value.title, "pwd");
  assertEquals(
    toolProgress(
      "shell",
      { command: "pwd", description: "Read the directory" },
      {},
      1,
    ),
    { name: "bash", title: "pwd", startedAt: 1 },
  );
  const unnamed = toolProgress("future", {}, {}, 1);
  assertEquals(unnamed, { name: "future", startedAt: 1 });
  assertEquals(unnamed, JSON.parse(JSON.stringify(unnamed)));
});
Deno.test("SQL split/inline labels and helper progress share owner-declared bounded fields", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,data TEXT)",
    );
    const call = tool(
      "task",
      {
        subagent_type: "junior",
        description: "Inspect",
        prompt: "DO NOT TRANSFER",
      },
      { sessionId: "ses_child" },
      "DO NOT TRANSFER",
    );
    call.state = {
      status: "running",
      input: {
        description: "Inspect",
        subagent_type: "junior",
        prompt: "DO NOT TRANSFER",
      },
      metadata: { sessionId: "ses_child" },
    };
    db.prepare(
      "INSERT INTO session_message VALUES ('msg','ses_fixture','assistant',1,1,?)",
    ).run(JSON.stringify({ content: [{ ...call, id: "inline" }] }));
    db.prepare(
      "INSERT INTO session_part VALUES ('msg','ses_fixture',1,'tool','call',?)",
    ).run(JSON.stringify(call));
    const reads = new TranscriptReads(
      new Messages(() => {
        throw new Error("No body API");
      }),
      () => db,
    );
    const labels = reads.tools("opcv2-ses_fixture", ["msg"])!;
    assertEquals(labels.map((r) => [r.tool.name, r.tool.summary, r.child]), [[
      "task",
      "Inspect",
      "ses_child",
    ], ["task", "Inspect", "ses_child"]]);
    assert(!JSON.stringify(labels).includes("DO NOT TRANSFER"));
    assertEquals(reads.helperAggregates("opcv2-ses_fixture", ["msg"]), [{
      messageID: "msg",
      toolCount: 2,
      current: toolProgress(call.name, call.state.input, {}, 1),
    }]);
    const sql = toolScalarSQL("data");
    assert(!sql.includes("prompt") && !sql.includes("content"));
    const projected = db.prepare(`SELECT ${sql} AS scalar FROM session_part`)
      .get()!;
    assert(!String(projected.scalar).includes("DO NOT TRANSFER"));
    const api = new TranscriptReads(
      {
        page: () =>
          Promise.resolve({
            items: [{ id: "msg", type: "assistant", content: [call] }],
            next: undefined,
          }),
      } as unknown as Messages,
      () => undefined,
    );
    const progress = await api.helperProgress(
      "opcv2-ses_fixture",
      new AbortController().signal,
    );
    assertEquals(
      derivedValue(progress.progress)?.current,
      reads.helperAggregates("opcv2-ses_fixture", ["msg"])![0].current,
    );
  } finally {
    db.close();
  }
});
