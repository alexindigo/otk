// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { Client, NativeRequestFailure } from "../client.ts";
import type { OperationContext } from "@otk/protocol";
import { prompt } from "../prompt.ts";
import { shell } from "../shell.ts";

Deno.test("classified native effect fences before I/O and reports ambiguous abort separately from rejection", async () => {
  const calls: string[] = [];
  const context: OperationContext = {
    key: { clientID: "client", key: "intent", window: "window" },
    signal: new AbortController().signal,
    progress() {},
    beforeEffect() {
      calls.push("fence");
      return Promise.resolve();
    },
    checkpoint: () => Promise.resolve(),
  };
  const cfg = {
    url: "http://fixture",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
    requestms: 10,
  };
  const client = new Client(cfg, () => {
    calls.push("http");
    return Promise.reject(new DOMException("private", "AbortError"));
  });
  const failure = await assertRejects(
    () =>
      client.json("/effect", {
        method: "POST",
        classification: "effect",
        operation: context,
      }),
    NativeRequestFailure,
  );
  assertEquals(calls, ["fence", "http"]);
  assertEquals(failure.outcome, "unknown");
  assertEquals(failure.failure.code, "native.unknown");
  const rejected = new Client(
    cfg,
    () =>
      Promise.resolve(
        Response.json({ _tag: "SessionBusyError", message: "private SQL" }, {
          status: 409,
        }),
      ),
  );
  const error = await assertRejects(
    () =>
      rejected.json("/effect", {
        method: "POST",
        classification: "effect",
        operation: context,
      }),
    NativeRequestFailure,
  );
  assertEquals(error.outcome, "rejected");
  assertEquals(error.failure.code, "session.busy");
});

Deno.test("classified native reads have one injected deadline and safe backend liveness facts", async () => {
  const cfg = {
    url: "http://fixture",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
    requestms: 5,
  };
  const client = new Client(
    cfg,
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        )
      ),
  );
  const error = await assertRejects(
    () => client.json("/read", { classification: "read" }),
    NativeRequestFailure,
  );
  assertEquals(error.outcome, "unavailable");
  assertEquals(error.failure.code, "native.unavailable");
});

Deno.test("mutating native ports forward the context and scoped launches join actual settlement", async () => {
  let fences = 0;
  const context: OperationContext = {
    key: { clientID: "client", key: "intent", window: "window" },
    signal: new AbortController().signal,
    progress() {},
    beforeEffect: () => {
      fences++;
      return Promise.resolve();
    },
    checkpoint: () => Promise.resolve(),
  };
  const client = new Client({
    url: "http://fixture",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
    requestms: 5,
  }, () => Promise.resolve(new Response(null, { status: 204 })));
  const directory = {
    cached: () => "/p",
    resolve: () => Promise.resolve("/p"),
  };
  await prompt(client, directory, () => {}).prompt({
    sessionID: "opcv1-ses_test",
    mode: "normal",
    parts: [{ kind: "text", text: "input" }],
  }, context);
  assertEquals(fences, 1);
  const held = Promise.withResolvers<void>();
  let received: OperationContext | undefined, completed = false;
  const port = shell(client, directory, (_id, _operation, _path, options) => {
    received = options?.operation;
    return { admitted: held.promise, settled: held.promise };
  });
  const work = port.shell({
    sessionID: "opcv1-ses_test",
    command: "pwd",
    agent: "build",
  }, context).then(() => {
    completed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(received, context);
  assertEquals(completed, false);
  held.resolve();
  await work;
  assertEquals(completed, true);
});
