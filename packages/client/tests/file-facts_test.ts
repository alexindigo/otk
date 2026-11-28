// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type FileFact,
  type InlineImageFact,
  MAX_STAT_PATHS,
} from "@otk/protocol";
import { createFileFacts } from "../file-facts.ts";
import { RequestFailure } from "../failures.ts";

const found = (path: string): FileFact => ({
  path,
  status: "file",
  resolved: `/${path}`,
  size: 0,
  preview: "text",
});
const absent = (path: string): FileFact => ({ path, status: "absent" });
const picture = (path: string): InlineImageFact => ({
  path,
  status: "image",
  resolved: `/${path}`,
  name: path,
  size: 32,
  mime: "image/png",
  width: 2,
  height: 3,
});
function fixture() {
  let now = 0;
  let answer = (paths: string[]) => paths.map(found);
  const calls: { sessionID: string; paths: string[] }[] = [];
  const imageCalls: { sessionID: string; paths: string[] }[] = [];
  let imageAnswer = (paths: string[]) => paths.map(picture);
  const queue = new Set<() => void>();
  const diagnostics: unknown[] = [];
  const facts = createFileFacts({
    call(_method, params) {
      calls.push(params);
      return Promise.resolve().then(() => answer(params.paths));
    },
  }, {
    now: () => now,
    schedule(run) {
      queue.add(run);
      return () => queue.delete(run);
    },
  }, {
    diagnostic: (cause) => diagnostics.push(cause),
    images: {
      call(method, params) {
        assertEquals(method, "file.images");
        imageCalls.push(params);
        return Promise.resolve().then(() => imageAnswer(params.paths));
      },
    },
  });
  return {
    facts,
    calls,
    imageCalls,
    images(fn: typeof imageAnswer) {
      imageAnswer = fn;
    },
    diagnostics,
    advance(ms: number) {
      now += ms;
    },
    answer(fn: typeof answer) {
      answer = fn;
    },
    async flush() {
      const work = [...queue];
      queue.clear();
      for (const run of work) run();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

Deno.test("facts batch one task, deduplicate consumers, and separate sessions", async () => {
  const f = fixture();
  const get = f.facts.fact("one", "0");
  for (let p = 0; p <= MAX_STAT_PATHS; p++) f.facts.fact("one", String(p));
  f.facts.fact("two", "0");
  assertEquals(get(), undefined);
  await f.flush();
  assertEquals(f.calls.map((c) => [c.sessionID, c.paths.length]), [
    ["one", MAX_STAT_PATHS],
    ["one", 1],
    ["two", 1],
  ]);
  assertEquals(get(), found("0"));
});

Deno.test("image facts share demand batches but keep independent TTLs and failure state", async () => {
  const f = fixture();
  const current = f.facts.image("s", "a");
  for (let i = 0; i < MAX_STAT_PATHS; i++) f.facts.image("s", String(i));
  f.facts.fact("s", "a");
  await f.flush();
  assertEquals(f.imageCalls.map((call) => call.paths.length), [64, 1]);
  assertEquals(f.calls.length, 1);
  assertEquals(current(), picture("a"));
  f.facts.imageFailed("s", "a");
  f.facts.imageFailed("s", "a");
  await f.flush();
  assertEquals(current(), { status: "unavailable", reason: "load-failed" });
  assertEquals(f.imageCalls.length, 3);
  f.advance(9_999);
  f.facts.image("s", "a");
  f.facts.image("s", "1");
  await f.flush();
  assertEquals(f.imageCalls.length, 3);
  f.advance(1);
  f.facts.image("s", "a");
  await f.flush();
  assertEquals(current(), picture("a"));
  f.advance(50_000);
  f.facts.image("s", "1");
  f.facts.image("s", "a");
  await f.flush();
  assertEquals(f.imageCalls.at(-1)?.paths, ["1"]);
});

Deno.test("image timeouts are not cached and old servers disable only file.images", async () => {
  const f = fixture();
  f.images((paths) => paths.map((path) => ({ path, status: "unknown" })));
  const lease = f.facts.image("s", "a");
  await f.flush();
  assertEquals(lease(), undefined);
  f.images(() => {
    throw new RequestFailure({
      code: "method",
      retry: "none",
      diagnosticID: "old",
    });
  });
  f.facts.image("s", "a");
  await f.flush();
  assertEquals(lease(), { status: "unavailable", reason: "unsupported" });
  assertEquals(f.facts.image("s", "b")(), lease());
  const stat = f.facts.fact("s", "a");
  await f.flush();
  assertEquals(stat(), found("a"));
  assertEquals(f.imageCalls.length, 2);
});

Deno.test("facts expire on demand, invalidate mounted consumers, and stop", async () => {
  const f = fixture();
  f.answer((paths) =>
    paths.map((path) => path === "n" ? absent(path) : found(path))
  );
  const positive = f.facts.fact("s", "p"), negative = f.facts.fact("s", "n");
  await f.flush();
  f.advance(10_000);
  assertEquals(negative(), absent("n"));
  f.facts.fact("s", "p");
  f.facts.fact("s", "n");
  await f.flush();
  assertEquals(f.calls[1].paths, ["n"]);
  f.advance(50_000);
  assertEquals(positive(), found("p"));
  f.facts.fact("s", "p");
  await f.flush();
  assertEquals(f.calls[2].paths, ["p"]);
  f.facts.invalidate("s", "p");
  assertEquals(positive(), undefined);
  await f.flush();
  assertEquals(f.calls[3].paths, ["p"]);
  f.facts.fact("s", "not-sent");
  f.facts.stop();
  await f.flush();
  assertEquals(f.calls.length, 4);
  assertEquals(positive(), undefined);
});

Deno.test("facts retain only 1024 results, least recently used first", async () => {
  const f = fixture();
  for (let i = 0; i < 1024; i++) f.facts.fact("s", String(i)).release();
  await f.flush();
  assertEquals(f.facts.fact("s", "0")(), found("0"));
  f.facts.fact("s", "new").release();
  await f.flush();
  assertEquals(f.facts.fact("s", "0")(), found("0"));
  assertEquals(f.facts.fact("s", "1")(), undefined);
  await f.flush();
  assertEquals(f.calls.at(-1)?.paths, ["1"]);
});

Deno.test("unknown and transport failures stay quiet and can be redemanded; method failure disables the owner", async () => {
  const f = fixture();
  f.answer((paths) => paths.map((path) => ({ path, status: "unknown" })));
  const get = f.facts.fact("s", "p");
  await f.flush();
  assertEquals(get(), undefined);
  f.answer(() => {
    throw new Error("socket offline");
  });
  f.facts.fact("s", "p");
  await f.flush();
  assertEquals(get(), undefined);
  assertEquals(f.diagnostics.length, 2);
  f.answer(() => {
    throw new RequestFailure({
      code: "method",
      retry: "none",
      diagnosticID: "old-sidecar",
    });
  });
  f.facts.fact("s", "p");
  await f.flush();
  assertEquals(f.facts.supported(), false);
  f.facts.fact("s", "another");
  await f.flush();
  assertEquals(f.calls.length, 3);
});
