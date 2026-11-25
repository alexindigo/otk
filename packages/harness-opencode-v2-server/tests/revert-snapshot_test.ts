// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Transcript } from "../transcript.ts";
import { factsFrom, scalarMessage } from "../transcript-reads.ts";
import type { V2Client } from "../client.ts";
import type { MessagePolicy } from "@otk/protocol";
import type { NativeMessage } from "../messages.ts";

Deno.test("V2 scoped archive reads only requested bodies and validates without bodies despite unrelated activity", async () => {
  const id = "opcv2-ses_fixture", reads: string[] = [];
  const row: NativeMessage = {
    id: "p",
    type: "user",
    text: "Exact prompt",
    time: { created: 1 },
  };
  const api = {
    session: {
      get: () =>
        Promise.resolve({
          id: "ses_fixture",
          projectID: "project",
          title: "Fixture",
          location: { directory: "/repo" },
          time: { created: 1, updated: 1 },
        }),
      message: {
        get: (input: { messageID: string }) => {
          reads.push(input.messageID);
          t.replay.publish(id, {
            op: "message.remove",
            messageID: "unrelated",
          });
          return Promise.resolve(row);
        },
      },
    },
    message: {
      list: () => {
        throw new Error("Archive must not scan the transcript");
      },
    },
  };
  const client = {
    service: { version: "2.2.6" },
    read: <T>(run: (api: unknown) => Promise<T>) => run(api),
  } as unknown as V2Client;
  const policy: MessagePolicy = {
    prefetchms: 1000,
    prefetchbytes: 1000,
    coolms: 1000,
    preloadms: 1000,
    concurrency: 1,
    replayops: 10,
    replaybytes: 10000,
    recoveryconcurrency: 1,
    recoverypending: 10,
    retryms: 100,
  };
  const t = new Transcript({
    client: () => client,
    policy,
    content() {},
    diagnostic() {},
    invalidated() {},
    facts: (input) =>
      Promise.resolve({
        ...factsFrom([scalarMessage(row, 1)], input.messages),
        source: "sql",
      }),
  });
  try {
    const signal = new AbortController().signal;
    const page = await t.snapshot(id, undefined, signal, { messageIDs: ["p"] });
    assertEquals(page.items.map((m) => m.id), ["p"]);
    assertEquals(page.revisions, { p: 0 });
    assertEquals(page.clock.seq > page.from.seq, true);
    const validation = await t.snapshot(id, undefined, signal, {
      messageIDs: ["p"],
      validate: true,
    });
    assertEquals(validation.items, []);
    assertEquals(validation.revisions, { p: 0 });
    assertEquals(reads, ["p"]);
    t.replay.publish(id, { op: "part.remove", messageID: "p", partID: "text" });
    const changed = await t.snapshot(id, undefined, signal, {
      messageIDs: ["p"],
      validate: true,
    });
    assertEquals(changed.revisions!.p > page.revisions!.p, true);
  } finally {
    await t.stop();
  }
});
