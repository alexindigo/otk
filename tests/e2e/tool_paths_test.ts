// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import {
  legacyStaticMessages,
  visualReply,
} from "../support/legacy-message-scene.ts";
import type { Part } from "@otk/protocol";
import { revealViewportElement } from "../support/message-viewport.ts";
test("tool headers, bodies and path-list results share project context, including outside paths and reload", async () => {
  await legacyStaticMessages("otk-dark", (root) => {
    const parts: Part[] = [];
    for (const outside of [false, true]) {
      const dir = outside ? "/outside" : root + "/src";
      for (const mode of ["read", "list", "glob"] as const) {
        const id = `${outside}-${mode}`;
        const base = {
          callID: id,
          status: "completed" as const,
          awaitingPermission: false,
          time: { start: 1000, end: 2000 },
        };
        parts.push({
          id,
          kind: "tool",
          call: mode === "read"
            ? {
              ...base,
              tool: "read",
              path: dir + "/probe.txt",
              loaded: outside ? [] : [root + "/src/AGENTS.md"],
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
        });
      }
    }
    parts.push({
      id: "cwd",
      kind: "tool",
      call: {
        tool: "bash",
        callID: "cwd",
        command: "pwd",
        cwd: root + "/src",
        output: root + "/src",
        status: "completed",
        awaitingPermission: false,
        time: { start: 1000, end: 2000 },
      },
    });
    return parts.map((part) =>
      visualReply(part.id, [part], { replyTo: "prompt-" + part.id })
    );
  }, async ({ b, capture }) => {
    for (
      const id of [
        "false-read",
        "false-list",
        "false-glob",
        "true-read",
        "true-list",
        "true-glob",
        "cwd",
      ]
    ) {
      const row = `[data-message="${id}"]`;
      await revealViewportElement(
        b,
        ".otk-messages",
        row + " .otk-tool-toggle",
      );
      await b.click(row + " .otk-tool-toggle");
      await b.poll(`!!document.querySelector('${row} .otk-tool-body')`);
      assertEquals(
        await b.evaluate(
          `!!document.querySelector('${row} .otk-tool-summary')`,
        ),
        false,
      );
      const expected = id === "cwd"
        ? "pwd"
        : id === "false-read"
        ? "src/probe.txt"
        : id.startsWith("false-")
        ? "src"
        : id === "true-read"
        ? "/outside/probe.txt"
        : "/outside";
      assertEquals(
        await b.evaluate(
          `document.querySelector('${row} .otk-tool-target').textContent`,
        ),
        expected,
      );
      await capture("paths-" + id);
    }
    await capture("relative-and-outside-paths");
  });
});
