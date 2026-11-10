// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapFileDiffs, mapTool } from "../map.ts";
import type { NativeMessage } from "../messages.ts";

type Tool = Extract<NativeMessage, { type: "assistant" }>["content"][number] & {
  type: "tool";
};
Deno.test("V2 file previews retain accepted patch moves despite source-only native headers", () => {
  const result = mapFileDiffs(
    [{
      file: "/repo/moved.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch:
        "--- /repo/move.txt\n+++ /repo/move.txt\n@@ -1 +1 @@\n-move me\n+moved\n",
    }],
    "*** Begin Patch\n*** Update File: move.txt\n*** Move to: moved.txt\n@@\n-move me\n+moved\n*** End Patch",
  );
  assertEquals(result[0].status, "moved");
  assertEquals(result[0].path, "/repo/moved.txt");
  assertEquals(result[0].oldPath, "/repo/move.txt");
  assertEquals(result[0].hunks[0].lines.map((line) => line.kind), [
    "del",
    "add",
  ]);
});
const tool = (
  name: string,
  input: Record<string, string>,
  output = "",
): Tool => ({
  type: "tool",
  id: "call_detail",
  name,
  time: { created: 1, ran: 1, completed: 2 },
  state: {
    status: "completed",
    input,
    content: [{ type: "text", text: output }],
  },
});
Deno.test("V2 typed source tools carry language and native working directory", () => {
  const write = mapTool(
    tool("write", { path: "/repo/source.py", content: "print(1)" }),
  );
  assertEquals(write.tool === "write" && write.lang, "python");
  const read = mapTool(
    tool(
      "read",
      { path: "/repo/source.ts" },
      "Read file /repo/source.ts, lines 1-1\n1: const n = 1;",
    ),
  );
  assertEquals(
    read.outputContent?.kind === "file" && read.outputContent.lang,
    "ts",
  );
  const shell = mapTool(tool("shell", { command: "pwd", cwd: "/repo/sub" }));
  assertEquals(shell.tool === "bash" && shell.cwd, "/repo/sub");
});
