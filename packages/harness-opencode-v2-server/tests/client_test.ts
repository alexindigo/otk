// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { type OperationContext, OperationFailure } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import { V2Client, V2MissingSession } from "../client.ts";
const service = {
  endpoint: { url: "http://127.0.0.1:42" },
  version: "2.2.6",
  pid: 42,
};

Deno.test("V2 effects fence every exchange, do not expire at finite-read deadlines, and classify lost outcomes without replay", async () => {
  let fences = 0, calls = 0;
  const operation: OperationContext = {
    signal: new AbortController().signal,
    key: { key: "key", clientID: "client", window: "window" },
    progress() {},
    beforeEffect: () => {
      fences++;
      return Promise.resolve();
    },
    checkpoint: () => Promise.resolve(),
    wait: (pending) => pending,
  };
  const owner = new V2Client(
    service,
    1,
    new AbortController().signal,
    async (_input, options) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      options?.signal?.throwIfAborted();
      return new Response(null, { status: 204 });
    },
  );
  await owner.effect(
    (api) => api.session.update({ sessionID: "ses_one", title: "One" }),
    operation,
  );
  await owner.effect(
    (api) => api.session.update({ sessionID: "ses_one", archived: true }),
    operation,
  );
  await owner.settled("ses_one", operation);
  assertEquals(
    [fences, calls],
    [2, 3],
    "wait observes settlement and is not a second mutation",
  );
  const lost = new V2Client(service, 1, new AbortController().signal, () => {
    calls++;
    return Promise.reject(new TypeError("lost response"));
  });
  const unknown = await assertRejects(
    () =>
      lost.effect(
        (api) => api.session.revert.clear({ sessionID: "ses_one" }),
        operation,
      ),
    OperationFailure,
  );
  assertEquals(unknown.outcome, "unknown");
  assertEquals([fences, calls], [3, 4]);
  const busy = new V2Client(
    service,
    1,
    new AbortController().signal,
    () =>
      Promise.resolve(
        Response.json({ _tag: "BusyError", sessionID: "ses_one" }, {
          status: 409,
        }),
      ),
  );
  const rejected = await assertRejects(
    () =>
      busy.effect((api) =>
        api.session.revert.stage({
          sessionID: "ses_one",
          messageID: "msg_one",
          files: false,
        }), operation),
    OperationFailure,
  );
  assertEquals(rejected.outcome, "rejected");
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
