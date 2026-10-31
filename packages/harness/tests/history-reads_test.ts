// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type HistoryAttachment,
  historyAttachmentCodec,
} from "../history-reads.ts";

Deno.test("attachment transport bounds bytes, retains exact order and releases staging on completion", () => {
  const items: HistoryAttachment[] = ["a", "b"].map((partID) => ({
    ref: { messageID: "m", partID },
    part: {
      kind: "file",
      source: "upload",
      name: partID,
      mime: "application/octet-stream",
      dataBase64: btoa(partID.repeat(100000)),
    },
  }));
  const chunks = [...historyAttachmentCodec.chunks(items, 1)];
  assert(chunks.length > 2);
  const builder = historyAttachmentCodec.create();
  for (const chunk of chunks) {
    assert("empty" in chunk || chunk.dataBase64.length <= 65536);
    builder.append(chunk);
  }
  assertEquals(builder.finish(), items);
  const incomplete = historyAttachmentCodec.create();
  incomplete.append(chunks[0]);
  assertThrows(() => incomplete.finish(), Error, "Incomplete");
  const overlap = historyAttachmentCodec.create();
  overlap.append(chunks[0]);
  assertThrows(() => overlap.append(chunks[0]), Error, "continuity");
  const missing = historyAttachmentCodec.create();
  assertThrows(() => missing.append(chunks[1]), Error, "start");
  const empty = historyAttachmentCodec.create();
  for (const chunk of historyAttachmentCodec.chunks([], 1)) empty.append(chunk);
  assertEquals(empty.finish(), []);
});
