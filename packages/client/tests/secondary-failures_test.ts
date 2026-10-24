// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  createInbox,
  createSessionSubmission,
  createSidecars,
  readSidecars,
} from "@otk/client";

Deno.test("successful session actions and submissions retain their result when visit bookkeeping fails", async () => {
  const failure = new Error("visit storage unavailable");
  const calls: string[] = [],
    logged: unknown[][] = [],
    previous = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const inbox = createInbox({
      call(method) {
        calls.push(method);
        return Promise.reject(failure);
      },
    });
    let submitted = 0;
    const value = { admitted: true };
    const submit = createSessionSubmission({
      sessionID: "s",
      directory: () => Promise.resolve("/p"),
      inbox,
      tabs: () => ({ send: (_id, action) => action() }),
    });
    assertStrictEquals(
      await submit(() => {
        submitted++;
        return Promise.resolve(value);
      }),
      value,
    );
    for (const action of ["approval", "answer", "interrupt"]) {
      assertEquals(
        await inbox.act("/p", () => Promise.resolve(action)),
        action,
      );
    }
    assertEquals(submitted, 1);
    assertEquals(calls, Array(4).fill("projects.visit"));
    assertEquals(logged.length, 4);
    assert(logged.every((args) => args.includes(failure)));
    const native = new Error("native action refused");
    assertEquals(
      await assertRejects(() => inbox.act("/p", () => Promise.reject(native))),
      native,
    );
    assertEquals(calls.length, 4);
    assertEquals(logged.length, 4);
  } finally {
    console.error = previous;
  }
});

Deno.test("diagnostic ports report bookkeeping separately even when their consumer throws", async () => {
  const failure = new Error("metadata failed"),
    diagnostic = new Error("diagnostic failed");
  const reported: unknown[] = [],
    fallback: unknown[][] = [],
    previous = console.error;
  console.error = (...args) => fallback.push(args);
  try {
    const inbox = createInbox(
      { call: () => Promise.reject(failure) },
      undefined,
      (error) => {
        reported.push(error);
        throw diagnostic;
      },
    );
    assertEquals(
      await inbox.act("/p", () => Promise.resolve("accepted")),
      "accepted",
    );
    assertEquals(reported, [failure]);
    assertEquals(fallback.length, 1);
    const aggregate = fallback[0].find((value) =>
      value instanceof AggregateError
    );
    assert(aggregate instanceof AggregateError);
    assertEquals(aggregate.errors, [failure, diagnostic]);
  } finally {
    console.error = previous;
  }
});

Deno.test("sidecar collection installs accepted entries and reports corrupt entry or envelope without saving", () => {
  const first = { id: "one", baseUrl: "https://one.test", label: "One" };
  const reported: unknown[] = [], writes: unknown[] = [];
  const collection = createSidecars(() => {}, {
    storage: {
      getItem: () => JSON.stringify([null, first]),
      setItem: (...args) => writes.push(args),
    },
    diagnostic: (error) => reported.push(error),
  });
  try {
    assertEquals(collection.state.list.map(({ id }) => id), ["local", "one"]);
    assert(collection.connection("one"));
    assertEquals(collection.state.list[1].baseUrl, first.baseUrl);
    assertEquals(reported.length, 1);
    assert(
      reported[0] instanceof Error && reported[0].message.includes("entry 0"),
    );
    assertEquals(writes, []);
    const bad: unknown[] = [];
    assertEquals(
      readSidecars({ getItem: () => "{" }, (error) => bad.push(error)).length,
      1,
    );
    assert(bad[0] instanceof SyntaxError);
  } finally {
    collection.stop();
  }
});

Deno.test("sidecar decoding keeps valid neighbours around malformed individual entries", () => {
  const first = { id: "one", baseUrl: "https://one.test", label: "One" },
    last = { id: "two", baseUrl: "https://two.test/prefix", label: "Two" };
  const logged: unknown[][] = [], previous = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const raw = JSON.stringify([
      first,
      null,
      { id: "bad", baseUrl: "not a URL", label: "bad" },
      12,
      { ...first, id: "local" },
      { ...last, id: "one" },
      last,
    ]);
    const storage = { getItem: () => raw };
    assertEquals(readSidecars(storage), [
      { id: "local", baseUrl: "", label: "This server" },
      first,
      last,
    ]);
    assertEquals(storage.getItem(), raw, "reading never rewrites saved data");
    assertEquals(logged.length, 5);
    for (const invalid of ["null", "{}", "{"]) {
      const count = logged.length;
      assertEquals(readSidecars({ getItem: () => invalid }).length, 1);
      assertEquals(logged.length, count + 1);
    }
  } finally {
    console.error = previous;
  }
});
