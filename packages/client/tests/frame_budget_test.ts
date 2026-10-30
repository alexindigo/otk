// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { RequestFailure, Rpc } from "@otk/client";
import {
  connectRequests,
  type FixtureRequest,
  replyRequest,
} from "../../../tests/support/request-wire.ts";
import type { PromptPart } from "@otk/protocol";

Deno.test("RPC rejects an oversized total before sending and releases the pending request", async () => {
  let sent = 0;
  let frame: FixtureRequest | undefined;
  const rpc = new Rpc((value) => {
    if (value.t === "request") {
      sent++;
      frame = value;
    }
  });
  connectRequests(rpc);
  const upload: PromptPart = {
    kind: "file",
    source: "upload",
    name: "part.txt",
    mime: "text/plain",
    dataBase64: "AAAA".repeat(17 * 1024 * 1024 / 4),
  };
  try {
    const failure = await assertRejects(
      () =>
        rpc.call("session.prompt", {
          sessionID: "budget",
          mode: "normal",
          parts: [upload, upload, upload, upload],
        }),
      RequestFailure,
    );
    assertEquals(failure.failure.code, "request.capacity");
    assertEquals(sent, 0);
    const next = rpc.call("session.prompt", {
      sessionID: "budget",
      mode: "normal",
      parts: [{ kind: "text", text: "ok" }],
    });
    assert(frame);
    replyRequest(rpc, frame, null);
    assertEquals(await next, null);
    assertEquals(sent, 1);
  } finally {
    rpc.close();
  }
});
