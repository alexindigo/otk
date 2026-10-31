// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { clockReadCodec, type ProviderReadPort } from "@otk/harness";
import { MessageClocks } from "../message-clocks.ts";
import { messageOutput, readMessageClock } from "../message-clock.ts";
import type { RawPart } from "../types.ts";

Deno.test("clock scalar SQL matches native output clocks without selecting bodies", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,data TEXT)",
  );
  const parts: Omit<RawPart, "id" | "sessionID" | "messageID">[] = [
    {
      type: "text",
      time: { start: 1, end: 5 },
      text: "Never select this body",
    },
    { type: "reasoning", time: { start: 1, end: 8 } },
    {
      type: "tool",
      state: { status: "completed", input: {}, time: { start: 1, end: 7 } },
    },
    { type: "step-finish", time: { start: 1, end: 100 } },
  ];
  for (const [i, part] of parts.entries()) {
    db.prepare("INSERT INTO part VALUES(?,?,?,?)").run(
      String(i),
      "s",
      "m",
      JSON.stringify(part),
    );
  }
  db.prepare("INSERT INTO part VALUES(?,?,?,?)").run(
    "other",
    "foreign",
    "m",
    JSON.stringify({ type: "text", time: { end: 1000 } }),
  );
  try {
    assertEquals(readMessageClock(db, "opcv1-s", "m"), { lastOutput: 8 });
    assertEquals(readMessageClock(db, "opcv1-s", "absent"), {
      lastOutput: null,
    });
    assertEquals(
      messageOutput(
        parts.map((p, i) => ({
          ...p,
          id: String(i),
          sessionID: "s",
          messageID: "m",
        })),
      ),
      { lastOutput: 8 },
    );
    const codec = clockReadCodec.create();
    for (const part of clockReadCodec.chunks({ lastOutput: 8 }, 1)) {
      codec.append(part);
    }
    assertEquals(codec.finish(), { lastOutput: 8 });
  } finally {
    db.close();
  }
});

Deno.test("clock demand coalesces, bounds fine keys and fences retired identity results", async () => {
  const pending: {
    signal?: AbortSignal;
    result: PromiseWithResolvers<{ lastOutput: number | null }>;
  }[] = [];
  const reads: ProviderReadPort = {
    read: ((_kind, _input, options) => {
      const result = Promise.withResolvers<{ lastOutput: number | null }>();
      pending.push({ signal: options.signal, result });
      return result.promise;
    }) as ProviderReadPort["read"],
    release() {},
  };
  const values: number[] = [], dirty: string[] = [];
  const clocks = new MessageClocks(
    reads,
    1,
    (id) => dirty.push(id),
    (error) => {
      throw error;
    },
  );
  const signal = new AbortController().signal;
  clocks.request("s", "m", signal, (n) => values.push(n));
  clocks.request("s", "m", signal, (n) => values.push(n));
  clocks.request("other", "m", signal, (n) => values.push(n));
  assertEquals(pending.length, 1);
  clocks.release("s", "m");
  assert(pending[0].signal?.aborted);
  pending[0].result.resolve({ lastOutput: 10 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(values, []);
  assertEquals(dirty, ["other"]);
  clocks.request("s", "m", signal, (n) => values.push(n));
  pending[1].result.resolve({ lastOutput: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(values, [5], "freshness is owner/revision, not numeric time");
  clocks.release();
});
