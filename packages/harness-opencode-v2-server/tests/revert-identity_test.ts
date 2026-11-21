// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { V2Client } from "../client.ts";
import { revertSession } from "../session-actions.ts";
import type { NativeMessage, NativeSession } from "../messages.ts";

Deno.test("V2 staged identity includes every native record once, never a later append", async () => {
  const rows = [
    { id: "z-boundary", type: "user", text: "Boundary", time: { created: 1 } },
    { id: "a-context", type: "system", text: "Context", time: { created: 2 } },
    { id: "m-reply", type: "assistant", time: { created: 3 }, parts: [] },
  ] as unknown as NativeMessage[];
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    new AbortController().signal,
    () =>
      Promise.resolve(Response.json({ data: [...rows].reverse(), cursor: {} })),
  );
  const raw = {
    id: "ses_identity",
    projectID: "p",
    title: "Identity",
    location: { directory: "/repo" },
    time: { created: 1, updated: 3 },
    revert: { messageID: "z-boundary", files: [] },
  } as unknown as NativeSession;
  const first = (await revertSession(client, raw)).revert!;
  assertEquals(Reflect.get(first, "boundaryID"), "z-boundary");
  assertEquals(Reflect.get(first, "messageIDs"), [
    "z-boundary",
    "a-context",
    "m-reply",
  ]);
  assertEquals(Object.hasOwn(first, "messageCount"), false);
  assertEquals(Object.hasOwn(first, "prompts"), false);
  rows.push(
    {
      id: "later",
      type: "user",
      text: "Later",
      time: { created: 4 },
    } as NativeMessage,
  );
  assertEquals((await revertSession(client, raw)).revert, first);
});
