// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { prepareAttachments } from "../attachment-batches.ts";
import type { PromptPart } from "@otk/protocol";
const history = (partID: string, sidecarID?: string): PromptPart => ({
  kind: "file",
  source: "history",
  name: partID,
  mime: "text/plain",
  size: 1,
  messageID: "m",
  partID,
  sidecarID,
});
Deno.test("attachment preparation batches and deduplicates by original server with exact order", async () => {
  const calls: unknown[] = [];
  const result = await prepareAttachments(
    [
      history("a", "other"),
      { kind: "text", text: "kept" },
      history("b"),
      history("a", "other"),
    ],
    "local",
    { concurrency: 2, maxrefs: 8, maxbytes: 16 },
    (origin, refs) => {
      calls.push([origin, refs]);
      return Promise.resolve(refs.map((ref) => ({
        ref,
        part: {
          kind: "file",
          source: "upload",
          name: ref.partID,
          mime: "text/plain",
          dataBase64: "eA==",
        },
      })));
    },
  );
  assertEquals(calls, [["other", [{ messageID: "m", partID: "a" }]], ["local", [
    { messageID: "m", partID: "b" },
  ]]]);
  assertEquals(
    result.map((part) =>
      part.kind === "file" && "name" in part
        ? part.name
        : part.kind === "text"
        ? part.text
        : ""
    ),
    ["a", "kept", "b", "a"],
  );
});
Deno.test("attachment admission is aggregate and a partial origin cannot admit a prompt", async () => {
  let calls = 0;
  await assertRejects(() =>
    prepareAttachments([history("a", "other"), history("b")], "local", {
      concurrency: 1,
      maxrefs: 8,
      maxbytes: 1,
    }, () => {
      calls++;
      return Promise.resolve([]);
    })
  );
  assertEquals(calls, 0);
  await assertRejects(() =>
    prepareAttachments([history("a", "other"), history("b")], "local", {
      concurrency: 1,
      maxrefs: 8,
      maxbytes: 8,
    }, (origin, refs) => {
      calls++;
      if (origin === "local") throw new Error("source rejected");
      return Promise.resolve(
        refs.map((ref) => ({
          ref,
          part: {
            kind: "file",
            source: "upload",
            name: "a",
            mime: "text/plain",
            dataBase64: "eA==",
          },
        })),
      );
    })
  );
  assertEquals(calls, 2);
});
