// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { Message, NativeSourceView } from "@otk/protocol";
import { createNativeSources } from "../native-sources.ts";

const turns = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const view = (preview: string): NativeSourceView => ({
  kind: "test",
  preview,
  bytes: preview.length,
  truncated: false,
});
const message = (ref = "opaque", detail = "first"): Message => ({
  role: "context",
  id: "message",
  sessionID: "session",
  time: { created: 1 },
  parts: [{
    kind: "external",
    id: "part",
    name: "record",
    activity: {
      kindLabel: "record",
      layout: "row",
      category: "record",
      tone: "normal",
      title: detail,
    },
    source: { kind: "test", ref },
  }],
});
function fixture(limit = 64) {
  const messages = { message: message() };
  const reads: {
    ref: string;
    signal: AbortSignal;
    resolve(value: NativeSourceView): void;
    reject(error: unknown): void;
  }[] = [];
  const owner = createNativeSources({
    messages: () => messages,
    limit,
    load: (ref, signal) =>
      new Promise((resolve, reject) =>
        reads.push({ ref, signal, resolve, reject })
      ),
  });
  return {
    owner,
    messages,
    reads,
    change(ref = "opaque", detail = "next") {
      messages.message = message(ref, detail);
      owner.sync();
    },
  };
}
Deno.test("closing Source before queued admission performs no read", async () => {
  const f = fixture(), a = f.owner.get("opaque");
  const release = a.retain();
  release();
  await turns();
  assertEquals(f.reads.length, 0);
  const reopen = a.retain();
  await turns();
  assertEquals(f.reads.length, 1);
  f.reads[0].resolve(view("current"));
  await turns();
  reopen();
  f.owner.stop();
});
Deno.test("Source ownership follows a moved opaque reference and later native-only part changes", async () => {
  const f = fixture(), owner = f.owner.get("opaque"), release = owner.retain();
  try {
    await turns();
    f.reads[0].resolve(view("original"));
    await turns();
    f.messages.message = {
      ...f.messages.message,
      parts: f.messages.message.parts.map((p) => ({ ...p, id: "moved" })),
    };
    f.owner.sync();
    await turns();
    assertEquals(f.reads.length, 2);
    f.reads[1].resolve(view("moved"));
    await turns();
    f.owner.changed("message", "part");
    await turns();
    assertEquals(f.reads.length, 2, "The old path no longer owns this Source");
    f.owner.changed("message", "moved");
    await turns();
    assertEquals(
      f.reads.length,
      3,
      "Native-only changes follow the current structural path",
    );
    f.reads[2].resolve(view("native-only moved update"));
    await turns();
    assertEquals(owner.state, {
      state: "ready",
      value: view("native-only moved update"),
    });
  } finally {
    release();
    f.owner.stop();
  }
});
Deno.test("Source demand is shared, lazy, and retains unchanged successful and failed outcomes", async () => {
  const f = fixture();
  const a = f.owner.get("opaque");
  await turns();
  assertEquals(f.reads.length, 0);
  const release = a.retain(), other = f.owner.get("opaque").retain();
  await turns();
  assertEquals(f.reads.length, 1);
  assertStrictEquals(a, f.owner.get("opaque"));
  f.reads[0].resolve(view("exact"));
  await turns();
  release();
  other();
  f.change("opaque", "first");
  const remount = f.owner.get("opaque").retain();
  await turns();
  assertEquals(f.reads.length, 1);
  assertEquals(a.state, { state: "ready", value: view("exact") });
  a.retry();
  await turns();
  assertEquals(f.reads.length, 2);
  f.reads[1].reject(new Error("native failure"));
  await turns();
  assertEquals(a.state.state, "failed");
  remount();
  const failedRemount = f.owner.get("opaque").retain();
  await turns();
  assertEquals(f.reads.length, 2);
  assertEquals(a.state.state, "failed");
  failedRemount();
  f.owner.stop();
});
Deno.test("open Source coalesces changed records and fences the obsolete pending result", async () => {
  const f = fixture(), a = f.owner.get("opaque"), states: string[] = [];
  a.subscribe((s) => {
    if (s.state === "ready") states.push(s.value.preview);
  });
  const release = a.retain();
  await turns();
  f.change("opaque", "second");
  f.change("opaque", "third");
  await turns();
  assertEquals(f.reads.length, 1);
  f.reads[0].resolve(view("obsolete"));
  await turns();
  assertEquals(states, []);
  assertEquals(f.reads.length, 2);
  f.reads[1].resolve(view("third"));
  await turns();
  assertEquals(states, ["third"]);
  release();
  f.change("opaque", "closed-change");
  await turns();
  assertEquals(f.reads.length, 2);
  const reopen = a.retain();
  await turns();
  assertEquals(f.reads.length, 3);
  f.reads[2].resolve(view("closed-change"));
  await turns();
  reopen();
  f.owner.stop();
});
Deno.test("Source replacement, removal and stop retire late work without cross-reference publication", async () => {
  const f = fixture(), old = f.owner.get("opaque");
  const release = old.retain();
  await turns();
  f.change("new-ref");
  assert(f.reads[0].signal.aborted);
  const next = f.owner.get("new-ref"), releaseNext = next.retain();
  await turns();
  f.reads[1].resolve(view("new source"));
  f.reads[0].resolve(view("old source"));
  await turns();
  assertEquals(old.state.state, "idle");
  assertEquals(next.state, { state: "ready", value: view("new source") });
  f.owner.clear();
  assertEquals(next.state.state, "idle");
  const cooled = f.owner.get("new-ref"), releaseCooled = cooled.retain();
  await turns();
  f.owner.stop();
  assert(f.reads[2].signal.aborted);
  f.reads[2].resolve(view("late"));
  await turns();
  assertEquals(cooled.state.state, "idle");
  release();
  releaseNext();
  releaseCooled();
});
Deno.test("Source cache never evicts a retained fold and equal live presentation still invalidates native source", async () => {
  const f = fixture(1), a = f.owner.get("opaque"), release = a.retain();
  await turns();
  f.reads[0].resolve(view("first"));
  await turns();
  f.owner.changed("message", "part");
  await turns();
  assertEquals(f.reads.length, 2);
  f.reads[1].resolve(view("native-only update"));
  await turns();
  f.messages.message = {
    ...f.messages.message,
    parts: [...f.messages.message.parts, {
      kind: "external",
      id: "another",
      name: "record",
      source: { kind: "test", ref: "another" },
    }],
  };
  f.owner.sync();
  const another = f.owner.get("another"), releaseOther = another.retain();
  await turns();
  assertStrictEquals(f.owner.get("opaque"), a);
  f.reads[2].resolve(view("another"));
  await turns();
  releaseOther();
  assertStrictEquals(f.owner.get("opaque"), a);
  release();
  f.owner.stop();
});
