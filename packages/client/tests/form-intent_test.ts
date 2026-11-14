// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createFormIntent,
  FailurePresenter,
  RequestFailure,
} from "@otk/client";

Deno.test("form intents reserve synchronously, join repeated submits and preserve the captured values", async () => {
  const owner = createFormIntent<{ name: string }, string>({
    capture: structuredClone,
    presenter: new FailurePresenter(),
  });
  const held = Promise.withResolvers<string>();
  let calls = 0, joined: Promise<string> | undefined;
  const value = { name: "perf" };
  const stop = owner.subscribe(() => {
    if (owner.state.pending) {
      joined = owner.submit({ name: "later edit" }, () => {
        throw new Error("Must join the original intent");
      });
    }
  });
  const first = owner.submit(value, async (captured) => {
    calls++;
    assertEquals(captured.name, "perf");
    return await held.promise;
  });
  value.name = "new draft";
  assertEquals(owner.state.captured?.name, "perf");
  assertEquals(joined, first);
  assert(owner.state.key);
  await Promise.resolve();
  assertEquals(calls, 1);
  stop();
  held.resolve("created");
  assertEquals(await first, "created");
  assertEquals(owner.state.pending, false);
  assertEquals(owner.state.feedback, undefined);
});

Deno.test("form feedback is structured and safe, and definite failure retains the submitted values", async () => {
  const presenter = new FailurePresenter();
  presenter.register(
    "credentials",
    () => ({
      kind: "error",
      text: "Check your username and password",
      field: "password",
    }),
  );
  const owner = createFormIntent<{ name: string }, void>({
    capture: structuredClone,
    presenter,
  });
  await assertRejects(() =>
    owner.submit(
      { name: "kept" },
      () => Promise.reject(new Error("private SQL /secret/path")),
    )
  );
  assertEquals(owner.state.captured, { name: "kept" });
  assertEquals(
    owner.state.feedback?.failure?.reason,
    "No publishable failure reason is available",
  );
  const key = owner.state.key;
  await assertRejects(() =>
    owner.submit(
      { name: "changed" },
      () =>
        Promise.reject(
          new RequestFailure({
            code: "credentials",
            retry: "new-intent",
            diagnosticID: "diagnostic",
          }),
        ),
    )
  );
  assert(owner.state.key !== key);
  assertEquals(owner.state.feedback?.field, "password");
  assertEquals(
    owner.state.feedback?.failure?.reason,
    "Check your username and password",
  );
  assert(owner.state.feedback?.failure?.recovery);
});
