// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ContentOp } from "@otk/protocol";
import { emptyContent, reduce } from "@otk/client";

Deno.test("a revert record is admitted by boundary identity, not a prompt count", () => {
  const record = {
    boundaryID: "context",
    messageIDs: ["context", "reply"],
    files: [],
  };
  const state = reduce(
    emptyContent(),
    { op: "session.revert", ...record } as unknown as ContentOp,
  );
  assertEquals<unknown>(state.revert, record);
  assertEquals(
    reduce(
      state,
      {
        op: "session.revert",
        messageIDs: [],
        files: [],
      } as unknown as ContentOp,
    ).revert,
    null,
  );
});
