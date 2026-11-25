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

function useHead(
  x: ReturnType<typeof fixture>,
  head: () => { id: string; seq: number; updated: number },
) {
  x.transcript.options.digest = {
    read: () => Promise.resolve(head()),
    release() {},
  } as unknown as NonNullable<typeof x.transcript.options.digest>;
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

Deno.test("initial page owns repair demand while its native boundary is still held", async () => {
  const x = fixture(),
    entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const page = x.transcript.reader.page.bind(x.transcript.reader);
  x.transcript.reader.page = async (...args) => {
    if (args[1] === 10) {
      entered.resolve();
      await gate.promise;
    }
    return await page(...args);
  };
  try {
    const reading = x.transcript.page(sessionID);
    await entered.promise;
    const clock = x.transcript.replay.clock(sessionID);
    x.rows.push(prompt("during-page", 2));
    await x.transcript.event({
      type: "session.message.content.updated",
      data: { sessionID: "ses_history", messageID: "during-page" },
    });
    assertEquals(
      x.transcript.replay.clock(sessionID),
      clock,
      "Repair must join the held boundary, not invalidate it with stream.reconcile",
    );
    gate.resolve();
    x.projection.replace((await reading).items);
    await x.transcript.check(sessionID);
    assertEquals(x.projection.state.messageIDs, ["before", "during-page"]);
    assertEquals(x.reads.filter((read) => read.limit === 10).length, 1);
  } finally {
    gate.resolve();
    await x.transcript.stop();
  }
});

Deno.test("fine recovery alone owns point checkpoints even when history observes the same head", async () => {
  const x = fixture();
  x.rows.splice(0, 1, { ...reply("recovering", 1), time: { created: 1 } });
  try {
    await x.transcript.page(sessionID);
    x.failure.next = new Error("Checkpoint unavailable");
    x.transcript.recovery.touch(sessionID, "recovering", "text");
    while (!x.diagnostics.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assertEquals(x.gets, ["recovering"]);
    // Production borrows a scalar SQL head, not the API's already-read body.
    x.transcript.options.digest = {
      read: () => Promise.resolve({ id: "recovering", seq: 1, updated: 1 }),
      release() {},
    } as unknown as NonNullable<typeof x.transcript.options.digest>;
    await x.transcript.check(sessionID);
    assertEquals(
      x.gets,
      ["recovering"],
      "History cannot silently retry the failed checkpoint",
    );
    assertEquals(
      x.transcript.recovery.snapshot(sessionID)[0].state,
      "unavailable",
    );
  } finally {
    await x.transcript.stop();
  }
});

Deno.test("completed fine recovery cannot hide a later changed native-head witness", async () => {
  const x = fixture();
  x.rows.splice(0, 1, reply("recovered", 1));
  let updated = 1;
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    x.transcript.options.digest = {
      read: () => Promise.resolve({ id: "recovered", seq: 1, updated }),
      release() {},
    } as unknown as NonNullable<typeof x.transcript.options.digest>;
    x.transcript.recovery.touch(sessionID, "recovered", "text");
    x.transcript.recovery.terminal(sessionID, "recovered");
    while (x.transcript.recovery.snapshot(sessionID).length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await x.transcript.check(sessionID);
    const reads = x.gets.length;
    assertEquals(
      reads,
      1,
      "The recovered checkpoint already covers this native witness",
    );
    const changed = reply("recovered", 1);
    assert(changed.type === "assistant");
    changed.content = [{
      type: "text",
      text: "Changed after the recovered checkpoint",
    }];
    x.rows[0] = changed;
    updated = 2;
    await x.transcript.check(sessionID);
    assertEquals(x.gets.length, reads + 1);
    assert(
      JSON.stringify(x.projection.messages()).includes(
        "Changed after the recovered checkpoint",
      ),
    );
  } finally {
    await x.transcript.stop();
  }
});

Deno.test("history revisits an omitted forward row when fine recovery releases it at the same native head", async () => {
  const x = fixture(),
    entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const get = x.transcript.reader.get.bind(x.transcript.reader);
  x.transcript.reader.get = async (session, message, signal) => {
    if (message === "omitted" && x.transcript.recovery.owns(session, message)) {
      entered.resolve();
      await gate.promise;
      signal?.throwIfAborted();
    }
    return await get(session, message, signal);
  };
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    x.rows.push(reply("omitted", 2), reply("new-head", 3));
    useHead(x, () => ({ id: "new-head", seq: 3, updated: 3 }));
    x.transcript.recovery.touch(sessionID, "omitted", "text");
    await entered.promise;
    await x.transcript.check(sessionID);
    assertEquals(x.projection.state.messageIDs, ["before", "new-head"]);
    // Relinquishing the point checkpoint does not prove the full body was
    // published (e.g. the missing part was individually restored).
    x.transcript.recovery.part("omitted", "text", sessionID);
    gate.resolve();
    await x.transcript.check(sessionID);
    assertEquals(x.projection.state.messageIDs, [
      "before",
      "omitted",
      "new-head",
    ]);
  } finally {
    gate.resolve();
    await x.transcript.stop();
  }
});

Deno.test("history rechecks a recovered anchor edited before a newer head appears", async () => {
  const x = fixture();
  x.rows[0] = reply("anchor", 1);
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    useHead(x, () => ({
      id: x.rows.at(-1)!.id,
      seq: x.rows.length,
      updated: x.rows.length,
    }));
    x.transcript.recovery.touch(sessionID, "anchor", "text");
    x.transcript.recovery.terminal(sessionID, "anchor");
    while (x.transcript.recovery.snapshot(sessionID).length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await x.transcript.check(sessionID);
    x.rows[0] = {
      ...reply("anchor", 1),
      content: [{ type: "text", text: "Edited before append" }],
    } as NativeMessage;
    x.rows.push(reply("new-head", 2));
    await x.transcript.check(sessionID);
    assertEquals(x.projection.state.messageIDs, ["anchor", "new-head"]);
    assert(
      JSON.stringify(x.projection.messages()).includes("Edited before append"),
    );
  } finally {
    await x.transcript.stop();
  }
});

Deno.test("history checkpoints cannot erase an event-owned running compaction summary", async () => {
  const x = fixture();
  x.rows.push({
    id: "compacting",
    type: "compaction",
    status: "running",
    reason: "manual",
    summary: "",
    time: { created: 2 },
  });
  try {
    x.projection.replace((await x.transcript.page(sessionID)).items);
    await x.transcript.event({
      id: "evt_compact_start",
      type: "session.compaction.started",
      created: 2,
      data: {
        sessionID: "ses_history",
        inputID: "compacting",
        reason: "manual",
      },
    });
    await x.transcript.event({
      id: "evt_compact_delta",
      type: "session.compaction.delta",
      created: 3,
      data: { sessionID: "ses_history", text: "Live queued summary" },
    });
    assert(
      JSON.stringify(x.projection.messages()).includes("Live queued summary"),
    );
    await x.transcript.check(sessionID);
    assert(
      JSON.stringify(x.projection.messages()).includes("Live queued summary"),
      "A persisted unfinished checkpoint cannot consume newer event-owned summary source",
    );
    await x.transcript.event({
      id: "evt_compact_end",
      type: "session.compaction.ended",
      created: 4,
      data: {
        sessionID: "ses_history",
        inputID: "compacting",
        text: "Final owned summary",
      },
    });
    const page = await x.transcript.page(sessionID);
    const part = page.items.find((message) =>
      message.id === "compacting"
    )!.parts[0];
    assert(part.kind === "external");
    assertEquals(part.activity?.state?.key, "completed");
    assert(JSON.stringify(part).includes("Final owned summary"));
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
