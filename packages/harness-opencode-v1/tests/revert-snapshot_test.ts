// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { ContentReplay } from "@otk/harness";
import { StreamBuffers } from "@otk/content";
import { cfg } from "../../../tests/support/config.ts";
import { Client } from "../client.ts";
import { Messages } from "../messages.ts";
import { Transcript } from "../transcript.ts";
import { mapSession } from "../map.ts";

Deno.test("V1 scoped archive reads only requested bodies and validates without bodies despite unrelated activity", async () => {
  const settings = cfg(), id = "opcv1-s", reads: string[] = [];
  const replay = new ContentReplay({
    ...settings.messages,
    nonce: () => crypto.randomUUID(),
    emit() {},
  });
  const reader = new Messages(
    new Client(settings.harness, () => {
      throw new Error("No collection scan");
    }),
    () => "/repo",
  );
  reader.get = (_id, messageID): ReturnType<Messages["get"]> => {
    reads.push(messageID);
    replay.publish(id, { op: "message.remove", messageID: "unrelated" });
    return Promise.resolve({
      info: {
        id: messageID,
        sessionID: "s",
        role: "user",
        time: { created: 1 },
      },
      parts: [{
        id: "text",
        sessionID: "s",
        messageID,
        type: "text",
        text: "Exact prompt",
      }],
    });
  };
  const t = new Transcript({
    replay,
    reader,
    buffers: new StreamBuffers(),
    raw: () =>
      Promise.resolve({
        id: "s",
        directory: "/repo",
        projectID: "project",
        title: "Fixture",
        time: { created: 1, updated: 1 },
      }),
    info: (raw) => Promise.resolve(mapSession(raw)),
    decorate: (message) => message,
    summaries: () => ({}),
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
  } finally {
    t.release();
  }
});
