// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { V2Client, V2MissingSession } from "../client.ts";
import { Messages } from "../messages.ts";
const service = {
  endpoint: { url: "http://127.0.0.1:42" },
  version: "2.2.6",
  pid: 42,
};

Deno.test("V2 shared inbox probe releases an aborted waiter without cancelling its owner", async () => {
  const gate = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  const caller = new AbortController();
  let requests = 0;
  const client = new V2Client(
    service,
    1000,
    new AbortController().signal,
    () => {
      requests++;
      entered.resolve();
      return gate.promise;
    },
  );
  const messages = new Messages(() => client);
  const first = messages.inbox("opcv2-ses_one", new AbortController().signal);
  await entered.promise;
  const second = messages.inbox("opcv2-ses_two", caller.signal);
  const reason = new DOMException("Caller left", "AbortError");
  let outcome: unknown;
  const settled = second.then(
    () => outcome = "resolved",
    (error) => outcome = error,
  );
  caller.abort(reason);
  try {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assertEquals(
      outcome,
      reason,
      "Waiter cancellation cannot wait for the shared probe",
    );
    assertEquals(requests, 1);
  } finally {
    gate.resolve(new Response(null, { status: 404 }));
    await settled;
    assertEquals((await first).state, "unsupported");
  }
});

Deno.test("V2 inbox capability discovery joins concurrent sessions, fences cancellation and resets with the endpoint generation", async () => {
  const gate = Promise.withResolvers<Response>(),
    entered = Promise.withResolvers<void>();
  const owner = new AbortController(), caller = new AbortController();
  let requests = 0;
  let client = new V2Client(service, 1000, owner.signal, () => {
    requests++;
    entered.resolve();
    return gate.promise;
  });
  const messages = new Messages(() => client);
  const first = messages.inbox("opcv2-ses_one", caller.signal);
  await entered.promise;
  const second = messages.inbox("opcv2-ses_two", caller.signal);
  gate.resolve(new Response(null, { status: 404 }));
  const values = await Promise.all([first, second]);
  assertEquals(values[0].state, "unsupported");
  assertEquals(values[1], values[0]);
  assertEquals(requests, 1);
  caller.abort();
  await assertRejects(
    () => messages.inbox("opcv2-ses_one", caller.signal),
    DOMException,
  );
  owner.abort();
  await assertRejects(
    () => messages.inbox("opcv2-ses_one", new AbortController().signal),
    DOMException,
  );
  client = new V2Client(
    service,
    1000,
    new AbortController().signal,
    (input) => {
      requests++;
      const session =
        new URL(input instanceof Request ? input.url : String(input)).pathname;
      return Promise.resolve(Response.json({ data: [{ id: session }] }));
    },
  );
  for (const id of ["ses_one", "ses_two"]) {
    const read = await messages.inbox(
      "opcv2-" + id,
      new AbortController().signal,
    );
    assertEquals(read.state, "available");
    if (read.state === "available") {
      assertEquals(read.items.map((row) => row.id), [
        `/api/session/${id}/inbox`,
      ]);
    }
  }
  assertEquals(requests, 3, "Available reads retain each session's own rows");
});

Deno.test("V2 inbox missing-session evidence is not optional capability absence", async () => {
  let requests = 0;
  const client = new V2Client(
    service,
    1000,
    new AbortController().signal,
    () => {
      requests++;
      return Promise.resolve(
        Response.json({ _tag: "SessionNotFoundError", message: "Missing" }, {
          status: 404,
        }),
      );
    },
  );
  const messages = new Messages(() => client);
  for (const id of ["ses_one", "ses_two"]) {
    await assertRejects(
      () => messages.inbox("opcv2-" + id, new AbortController().signal),
      V2MissingSession,
    );
  }
  assertEquals(
    requests,
    2,
    "One absent session cannot disable another session's queue",
  );
});
