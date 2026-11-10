// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { type OperationContext, OperationFailure } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import { V2Client, V2HttpFailure, V2MissingSession } from "../client.ts";
const service = {
  endpoint: { url: "http://127.0.0.1:42" },
  version: "2.2.6",
  pid: 42,
};

Deno.test("V2 effect diagnostics retain HTTP status/ref and native settled tags independently of certainty", async () => {
  const client = new V2Client(
    service,
    1000,
    new AbortController().signal,
    () =>
      Promise.resolve(
        Response.json({
          name: "ProxyFailure",
          data: { message: "Unavailable", ref: "proxy-ref" },
        }, { status: 503 }),
      ),
  );
  const error = await assertRejects(
    () =>
      client.effect((api) =>
        api.session.shell({ sessionID: "ses_one", command: "true" })
      ),
    OperationFailure,
  );
  assertEquals(error.outcome, "unknown");
  let cause: unknown = error;
  while (
    cause && typeof cause === "object" && !(cause instanceof V2HttpFailure)
  ) cause = Reflect.get(cause, "cause");
  assertEquals(cause instanceof V2HttpFailure && cause.status, 503);
  assertEquals(cause instanceof V2HttpFailure && cause.detail.ref, "proxy-ref");
  const settled = new V2Client(
    service,
    1000,
    new AbortController().signal,
    () =>
      Promise.resolve(
        Response.json({ _tag: "FormNotFoundError", message: "Settled" }, {
          status: 404,
        }),
      ),
  );
  assertEquals(
    await settled.effect(
      (api) =>
        api.session.form.cancel({ sessionID: "ses_one", formID: "form_one" }),
      undefined,
      ["FormNotFoundError"],
    ),
    undefined,
  );
});

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

Deno.test("V2 effect HTTP provenance tolerates non-record error bodies", async () => {
  for (const body of [null, [], "unknown"]) {
    const client = new V2Client(
      service,
      1000,
      new AbortController().signal,
      () => Promise.resolve(Response.json(body, { status: 503 })),
    );
    const failure = await assertRejects(
      () =>
        client.effect((api) =>
          api.session.shell({ sessionID: "ses_one", command: "true" })
        ),
      OperationFailure,
    );
    assertEquals(
      failure.cause instanceof V2HttpFailure && failure.cause.status,
      503,
    );
  }
});

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

Deno.test("V2 worker cancellation joins the real exchange before releasing native permission", async () => {
  const owner = new AbortController(),
    entered = Promise.withResolvers<void>(),
    body = Promise.withResolvers<number>();
  let releases = 0, settled = false;
  const wait = <T>(value: Promise<T>, join = false): Promise<T> => {
    if (join) return value;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(owner.signal.reason);
      owner.signal.addEventListener("abort", abort, { once: true });
      value.then(resolve, reject).finally(() =>
        owner.signal.removeEventListener("abort", abort)
      );
      if (owner.signal.aborted) abort();
    });
  };
  const client = new V2Client(
    service,
    1000,
    owner.signal,
    fetch,
    () => Promise.resolve(() => releases++),
    wait,
  );
  const reading = client.read(() => {
    entered.resolve();
    return body.promise;
  });
  const rejected = assertRejects(() => reading, DOMException, "retired");
  void reading.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await entered.promise;
  owner.abort(new DOMException("retired", "AbortError"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    assertEquals(releases, 0);
    assertEquals(settled, false);
  } finally {
    body.resolve(42);
    await rejected;
  }
  assertEquals(releases, 1);
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
