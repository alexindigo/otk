// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createTranscriptProjection } from "@otk/client";
import type { MessagePolicy } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import { mapMessage } from "../map.ts";
import {
  nativeCursor,
  nativeForwardCursor,
  type NativeMessage,
} from "../messages.ts";
import {
  factsFrom,
  scalarMessage,
  TranscriptReads,
} from "../transcript-reads.ts";
import { Transcript } from "../transcript.ts";
import { requestFailureFacts } from "../request-failure.ts";

const sessionID = "opcv2-ses_history";
const policy: MessagePolicy = {
  prefetchms: 1000,
  prefetchbytes: 1048576,
  coolms: 1000,
  preloadms: 1000,
  concurrency: 2,
  replayops: 128,
  replaybytes: 1048576,
  recoveryconcurrency: 2,
  recoverypending: 32,
  retryms: 1000,
};
const prompt = (id: string, created: number): NativeMessage => ({
  id,
  type: "user",
  text: id,
  time: { created },
});
const reply = (id: string, created: number): NativeMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "test" },
  content: [{ type: "text", text: "reply after compaction" }],
  time: { created, completed: created + 1 },
});
function fixture(retryms = 1000) {
  const rows: NativeMessage[] = [prompt("before", 1)];
  const failure: { next?: Error } = {};
  const diagnostics: unknown[] = [];
  const gets: string[] = [];
  const projection = createTranscriptProjection();
  const reads: { limit: number; cursor?: string }[] = [];
  const client = {
    service: { version: "2.2.6" },
    failureFacts: requestFailureFacts,
    read: <T>(run: (api: unknown) => Promise<T>) =>
      run({
        session: {
          get: () =>
            Promise.resolve({
              id: "ses_history",
              projectID: "project",
              location: { directory: "/project" },
              time: { created: 1, updated: 1 },
            }),
          inbox: { list: () => Promise.resolve([]) },
          message: {
            get: ({ messageID }: { messageID: string }) => {
              gets.push(messageID);
              return failure.next
                ? (() => {
                  const error = failure.next;
                  failure.next = undefined;
                  return Promise.reject(error);
                })()
                : Promise.resolve(
                  structuredClone(rows.find((r) => r.id === messageID)),
                );
            },
          },
        },
        message: {
          list: (input: { limit: number; cursor?: string }) => {
            reads.push(input);
            const cursor = input.cursor
              ? JSON.parse(
                atob(input.cursor.replaceAll("-", "+").replaceAll("_", "/")),
              )
              : undefined;
            const at = cursor
              ? rows.findIndex((r) => r.id === cursor.id)
              : rows.length;
            const page = cursor?.order === "asc"
              ? rows.slice(at + 1, at + 1 + input.limit)
              : rows.slice(Math.max(0, at - input.limit), at).reverse();
            return Promise.resolve({
              data: structuredClone(page),
              cursor: {
                next: page.length === input.limit
                  ? (cursor?.order === "asc"
                    ? nativeForwardCursor(page.at(-1)!.id)
                    : nativeCursor(page.at(-1)!.id))
                  : undefined,
              },
            });
          },
        },
      }),
  } as unknown as V2Client;
  const transcript = new Transcript({
    client: () => client,
    policy: { ...policy, retryms },
    facts: (input) =>
      Promise.resolve(
        factsFrom(
          rows.map((r, i) => scalarMessage(r, i + 1)),
          input.messages,
          input.cutoff,
        ),
      ),
    content: (_id, op) => {
      projection.apply(op);
    },
    diagnostic: (error) => {
      diagnostics.push(error);
    },
    invalidated() {},
  });
  transcript.subscriptions(sessionID, 1);
  return { rows, projection, transcript, reads, gets, failure, diagnostics };
}
Deno.test("native head is a keyed scalar witness and respects a staged boundary", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,time_updated INTEGER)",
    );
    const insert = db.prepare("INSERT INTO session_message VALUES(?,?,?,?)");
    insert.run("a", "ses_history", 10, 100);
    insert.run("b", "ses_history", 20, 200);
    insert.run("other", "ses_other", 100, 900);
    const reader = new TranscriptReads({} as never, () => db);
    assertEquals(reader.head(sessionID), { id: "b", seq: 20, updated: 200 });
    assertEquals(reader.head(sessionID, "b"), {
      id: "a",
      seq: 10,
      updated: 100,
    });
    db.prepare("UPDATE session_message SET time_updated=201 WHERE id='b'")
      .run();
    assertEquals(reader.head(sessionID), { id: "b", seq: 20, updated: 201 });
  } finally {
    db.close();
  }
});
Deno.test("native history repairs a missed compaction, prompt and reply without a live event", async () => {
  const x = fixture();
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    x.rows.push(
      {
        id: "compact",
        type: "compaction",
        status: "completed",
        reason: "manual",
        summary: "summary",
        time: { created: 2 },
      },
      prompt("Pickup context", 3),
      reply("after", 4),
    );
    await x.transcript.check(sessionID);
    assertEquals(x.projection.state.messageIDs, [
      "before",
      "compact",
      "Pickup context",
      "after",
    ]);
    const marker = x.projection.state.messagesByID.compact.parts[0];
    assert(
      marker.kind === "external" && marker.activity?.layout === "boundary",
    );
    assert(marker.activity.title.startsWith("Session compacted"));
    assertEquals(x.projection.state.messagesByID.after.role, "assistant");
    assert(x.reads.some((r) => r.cursor === nativeForwardCursor("before")));
    const count = x.reads.length;
    await x.transcript.check(sessionID);
    assertEquals(
      x.reads.length,
      count + 1,
      "An unchanged native head costs only one bounded probe",
    );
  } finally {
    await x.transcript.stop();
  }
});

Deno.test("history checkpoints use native identities when a failure has a different presentation identity", async () => {
  const x = fixture();
  try {
    x.rows.push(
      {
        id: "native-failure",
        type: "idle",
        outcome: "failed",
        error: { type: "unknown", message: "Provider failure" },
        time: { created: 2 },
      } as NativeMessage,
    );
    x.projection.replace((await x.transcript.page(sessionID)).items);
    assert(
      x.projection.state.messageIDs.some((id) =>
        id.startsWith("request:failure:")
      ),
    );
    await x.transcript.check(sessionID);
    assert(
      x.gets.every((id) => x.rows.some((row) => row.id === id)),
      "A presentation identity must never reach the native reader",
    );
    assertEquals(x.diagnostics, []);
  } finally {
    await x.transcript.stop();
  }
});
Deno.test("acquired history detects and repairs a gap by itself, and stops on unsubscribe", async () => {
  const x = fixture(5);
  x.transcript.start();
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    x.rows.push(prompt("automatic", 2));
    const end = Date.now() + 1000;
    while (!x.projection.state.messagesByID.automatic) {
      if (Date.now() > end) {
        throw new Error("Automatic native history repair did not run");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    x.transcript.subscriptions(sessionID, 0);
    const count = x.reads.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assertEquals(
      x.reads.length,
      count,
      "No checks survive the transcript demand",
    );
  } finally {
    await x.transcript.stop();
  }
});
Deno.test("gap repair crosses bounded pages and includes unknown native messages and parts", async () => {
  const x = fixture();
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    for (let i = 0; i < 230; i++) x.rows.push(prompt(`gap-${i}`, i + 2));
    const unknown = {
      ...reply("unknown-part", 240),
      content: [{ type: "future-part", value: "retained" }],
    } as unknown as NativeMessage;
    x.rows.push(unknown);
    x.rows.push(
      {
        id: "unknown-message",
        type: "future-message",
        value: "record",
        time: { created: 241 },
      } as unknown as NativeMessage,
    );
    await x.transcript.check(sessionID);
    assertEquals(x.projection.state.messageIDs.length, x.rows.length);
    assertEquals(x.projection.state.messageIDs.at(-1), "unknown-message");
    const part = x.projection.state.messagesByID["unknown-part"].parts.find(
      (p) => p.kind === "external" && p.name === "future-part",
    );
    assert(part?.kind === "external" && part.source?.ref);
    assert(
      (await x.transcript.source(
        sessionID,
        part.source.ref,
        new AbortController().signal,
      )).preview.includes("retained"),
    );
    assertEquals(
      mapMessage(x.rows.at(-1)!, sessionID, { order: 999 }).role,
      "context",
    );
    assert(x.reads.every((r) => r.limit <= 200));
  } finally {
    await x.transcript.stop();
  }
});
Deno.test("unmapped native content replacement repairs the same identity without a new head", async () => {
  const x = fixture();
  try {
    x.rows.push(reply("replace", 2));
    x.projection.replace((await x.transcript.page(sessionID)).items);
    await x.transcript.check(sessionID);
    x.rows[1] = {
      ...reply("replace", 2),
      content: [{ type: "future-part", value: "replacement" }],
    } as unknown as NativeMessage;
    await x.transcript.event({
      type: "session.message.content.updated",
      id: "evt_replace",
      data: { sessionID: "ses_history", messageID: "replace", content: [] },
    });
    await x.transcript.check(sessionID);
    const part = x.projection.state.messagesByID.replace.parts.find((p) =>
      p.kind === "external" && p.name === "future-part"
    );
    assert(part?.kind === "external" && part.source?.ref);
    assert(
      (await x.transcript.source(
        sessionID,
        part.source.ref,
        new AbortController().signal,
      )).preview.includes("replacement"),
    );
    assertEquals(x.projection.state.messageIDs, ["before", "replace"]);
    assert(
      !x.reads.some((r) => r.cursor === nativeCursor("replace")),
      "Replacement is a keyed read, not an older-history scan",
    );
  } finally {
    await x.transcript.stop();
  }
});

Deno.test("failed in-place repair retains its obligation even when the native head is unchanged", async () => {
  const x = fixture();
  try {
    x.rows.push(reply("replace-older", 2), prompt("later", 3));
    x.projection.replace((await x.transcript.page(sessionID)).items);
    await x.transcript.check(sessionID);
    x.rows[1] = {
      ...reply("replace-older", 2),
      content: [{ type: "future-part", value: "retried" }],
    } as unknown as NativeMessage;
    x.failure.next = new Error("temporary native read failure");
    await x.transcript.event({
      type: "session.message.content.updated",
      id: "evt_failed_read",
      data: { sessionID: "ses_history", messageID: "replace-older" },
    });
    await assertRejects(
      () => x.transcript.check(sessionID),
      Error,
      "temporary native read failure",
    );
    await x.transcript.check(sessionID);
    assert(
      x.projection.state.messagesByID["replace-older"].parts.some((p) =>
        p.kind === "external" && p.name === "future-part"
      ),
    );
  } finally {
    await x.transcript.stop();
  }
});
