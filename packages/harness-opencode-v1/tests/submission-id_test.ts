// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch } from "@std/assert";
import { submissionID } from "../submission-id.ts";
import { prompt } from "../prompt.ts";
import type { Client } from "../client.ts";
import type { Directory } from "../directory.ts";

Deno.test("V1 submission identities keep native shape and order within the same clock", () => {
  const now = Date.now;
  Date.now = () => 1794751200000;
  try {
    const first = submissionID(), second = submissionID();
    assertMatch(first, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assertEquals(
      first.slice(4, 16),
      (BigInt(Date.now()) * 0x1000n + 1n).toString(16).slice(-12),
    );
    assert(second > first);
  } finally {
    Date.now = now;
  }
});

Deno.test("V1 sends and returns the caller-captured native prompt identity", async () => {
  let sent: unknown;
  const client = {
    request(_path: string, options: { body: unknown }) {
      sent = options.body;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  } as unknown as Client;
  const directory = {
    resolve: () => Promise.resolve("/workspace"),
  } as unknown as Directory;
  const id = "msg_123456789abcdef01234567890";
  const receipt = await prompt(client, directory, () => {}).prompt({
    sessionID: "opcv1-ses_pending",
    messageID: id,
    mode: "normal",
    parts: [{ kind: "text", text: "Preserve this identity" }],
  });
  assertEquals((sent as { messageID: string }).messageID, id);
  assertEquals(receipt, { messageID: id, state: "accepted" });
});
