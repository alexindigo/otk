// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type ContentOp, type MessagePolicy, sourceAt } from "@otk/protocol";
import { mapMessage } from "../map.ts";
import { HarnessError } from "@otk/harness";
import type { NativeMessage } from "../messages.ts";
import { parseSourceRef } from "../native-source.ts";
import { Transcript } from "../transcript.ts";

const sid = "opcv2-ses_fixture";
const policy: MessagePolicy = {
  prefetchms: 1000,
  prefetchbytes: 100000,
  coolms: 1000,
  preloadms: 1000,
  concurrency: 2,
  replayops: 128,
  replaybytes: 1048576,
  recoveryconcurrency: 2,
  recoverypending: 32,
  retryms: 100,
};
Deno.test("V2 loaded records carry references; a Source read derives the exact source again", async () => {
  const raw = {
    id: "msg_notice",
    type: "synthetic",
    text: "body",
    metadata: { envelope: true },
    time: { created: 1 },
  } as NativeMessage;
  const updates: ContentOp[] = [];
  let reads = 0, fail = false, missing = false;
  const transcript = new Transcript({
    client: () =>
      ({
        read: (call: (api: unknown) => unknown) =>
          call({
            session: {
              message: {
                get: (input: { messageID: string }) => {
                  reads++;
                  if (missing) {
                    return Promise.reject(
                      Object.assign(new Error("gone"), {
                        _tag: "MessageNotFoundError",
                      }),
                    );
                  }
                  if (fail) {
                    return Promise.reject(new Error("native read failed"));
                  }
                  assertEquals(input.messageID, "msg_notice");
                  return Promise.resolve(raw);
                },
              },
            },
          }),
      }) as never,
    policy,
    content: (_id, op) => {
      updates.push(op);
    },
    diagnostic() {},
    invalidated() {},
  });
  transcript.subscriptions(sid, 1);
  try {
    await transcript.event({
      type: "session.synthetic",
      id: "evt_notice",
      created: 1,
      metadata: { envelope: true },
      durable: { seq: 1 },
      data: { sessionID: "ses_fixture", text: "body" },
    });
    const upsert = updates.find((op) => op.op === "message.upsert");
    assert(upsert?.op === "message.upsert");
    const part = upsert.message.parts[0];
    assert(part.kind === "external" && part.source?.ref);
    assertEquals(part.source.preview, undefined);
    // Declared content keeps exactly its copy text.
    assertEquals(part.source.payload, "body");
    assertEquals(reads, 0);
    const derived = mapMessage(raw, sid, { order: 1 });
    for (const ref of [upsert.message.source!.ref!, part.source.ref]) {
      const view = await transcript.source(
        sid,
        ref,
        new AbortController().signal,
      );
      assertEquals(view, sourceAt(derived, parseSourceRef(ref).path));
      assert(view.preview.includes('"envelope":true'));
    }
    assertEquals(reads, 2);
    fail = true;
    // Every failure says why, in the plugin's words, with a fitting next step.
    const failure = async (ref: string) => {
      const error = await assertRejects(() =>
        transcript.source(sid, ref, new AbortController().signal)
      );
      assert(error instanceof HarnessError);
      return [error.code, error.facts?.reason, error.facts?.recovery];
    };
    assertEquals(await failure(part.source.ref), [
      "source.read",
      "opencode could not return the native message",
      "Retry",
    ]);
    missing = true;
    assertEquals(await failure(part.source.ref), [
      "source.message",
      "The native message for this record no longer exists",
      "This record's source is no longer available",
    ]);
    assertEquals(await failure("v2:garbage"), [
      "source.reference",
      "This source reference is no longer valid",
      "Reload the conversation, then open Source again",
    ]);
  } finally {
    await transcript.stop();
  }
});
