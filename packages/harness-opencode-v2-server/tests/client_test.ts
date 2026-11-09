// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import { V2Client, V2MissingSession } from "../client.ts";
const service = {
  endpoint: { url: "http://127.0.0.1:42" },
  version: "2.2.6",
  pid: 42,
};

Deno.test("V2 finite reads retain the shared native permission through SDK body settlement and release late grants", async () => {
  const owner = new AbortController(),
    grant = Promise.withResolvers<() => void>(),
    result = Promise.withResolvers<number>();
  let releases = 0, entered = false;
  const client = new V2Client(
    service,
    1000,
    owner.signal,
    fetch,
    () => grant.promise,
  );
  const reading = client.read(() => {
    entered = true;
    return result.promise;
  });
  await Promise.resolve();
  assertEquals(entered, false);
  grant.resolve(() => {
    releases++;
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(entered, true);
  assertEquals(releases, 0);
  result.resolve(42);
  assertEquals(await reading, 42);
  assertEquals(releases, 1);
  const late = Promise.withResolvers<() => void>(),
    cancel = new AbortController();
  const waiting = new V2Client(
    service,
    1000,
    cancel.signal,
    fetch,
    () => late.promise,
  );
  let dispatched = false;
  const pending = waiting.read(() => {
    dispatched = true;
    return Promise.resolve(0);
  });
  const rejected = assertRejects(() => pending, DOMException, "retired");
  cancel.abort(new DOMException("retired", "AbortError"));
  late.resolve(() => {
    releases++;
  });
  await rejected;
  assertEquals(dispatched, false);
  assertEquals(releases, 2);
});

Deno.test("V2 finite-read owner classifies missing, authentication and unavailable SDK errors", async () => {
  const read = (fetcher: typeof fetch) => {
    const client = new V2Client(
      service,
      1000,
      new AbortController().signal,
      fetcher,
    );
    return client.read((api) => api.session.get({ sessionID: "ses_missing" }));
  };
  const missing = await assertRejects(
    () =>
      read(() =>
        Promise.resolve(
          Response.json({
            _tag: "SessionNotFoundError",
            message: "Session not found: ses_missing",
          }, { status: 404 }),
        )
      ),
    V2MissingSession,
  );
  assertEquals(missing.message.includes("ses_missing"), false);
  await assertRejects(
    () =>
      read(() =>
        Promise.resolve(
          Response.json(
            { _tag: "UnauthorizedError", message: "native detail" },
            { status: 401 },
          ),
        )
      ),
    HarnessError,
    "401",
  );
  await assertRejects(
    () =>
      read(() =>
        Promise.resolve(new Response("Unauthorized", { status: 401 }))
      ),
    HarnessError,
    "401",
  );
  const unavailable = await assertRejects(
    () => read(() => Promise.reject(new TypeError("connection refused"))),
    OperationFailure,
  );
  assertEquals([unavailable.outcome, unavailable.code], [
    "unavailable",
    "native.unavailable",
  ]);
});

Deno.test("V2 read cancellation reaches the SDK without caller-specific transport wiring", async () => {
  const owner = new AbortController(), caller = new AbortController();
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  const client = new V2Client(
    service,
    1000,
    owner.signal,
    (_input, options) =>
      new Promise((_resolve, reject) => {
        entered.resolve();
        options!.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(options!.signal!.reason);
        }, { once: true });
      }),
  );
  const reading = client.read(
    (api) => api.session.get({ sessionID: "ses_one" }),
    caller.signal,
  );
  const rejected = assertRejects(() => reading, DOMException, "cancelled");
  await entered.promise;
  caller.abort(new DOMException("cancelled", "AbortError"));
  await rejected;
  assertEquals(aborted, true);
});

Deno.test("V2 read deadlines remain unavailable, while late lifecycle continuations stay cancelled", async () => {
  const owner = new AbortController();
  const client = new V2Client(
    service,
    5,
    owner.signal,
    (_input, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        );
      }),
  );
  const failure = await assertRejects(
    () => client.read((api) => api.session.get({ sessionID: "ses_one" })),
    OperationFailure,
  );
  assertEquals(failure.outcome, "unavailable");
  const gate = Promise.withResolvers<number>();
  const pending = client.read(() => gate.promise);
  const cancelled = assertRejects(() => pending, DOMException, "retired");
  owner.abort(new DOMException("retired", "AbortError"));
  gate.resolve(42);
  await cancelled;
});
