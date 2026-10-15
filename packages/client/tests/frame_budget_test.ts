// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { Rpc } from "@otk/client";
import type { PromptPart } from "@otk/protocol";

Deno.test("RPC rejects an oversized total before sending and releases the pending request", async () => {
  let sent = 0;
  const rpc = new Rpc(() => sent++);
  const upload: PromptPart = {
    kind: "file",
    source: "upload",
    name: "part.txt",
    mime: "text/plain",
    dataBase64: "AAAA".repeat(17 * 1024 * 1024 / 4),
  };
  try {
    await assertRejects(
      () =>
        rpc.call("session.prompt", {
          sessionID: "budget",
          mode: "normal",
          parts: [upload, upload, upload, upload],
        }),
      Error,
      "64 MiB",
    );
    assertEquals(sent, 0);
    const next = rpc.call("session.prompt", {
      sessionID: "budget",
      mode: "normal",
      parts: [{ kind: "text", text: "ok" }],
    });
    rpc.receive({ t: "rpc.result", id: "2", ok: true, result: null });
    assertEquals(await next, null);
    assertEquals(sent, 1);
  } finally {
    rpc.close();
  }
});
