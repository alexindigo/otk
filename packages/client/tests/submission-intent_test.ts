// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createSubmissionIntent, FailurePresenter } from "@otk/client";

Deno.test("a pending native submission does not swallow a later input command or admit another send", async () => {
  const intent = createSubmissionIntent<{ text: string }>({
    capture: structuredClone,
    presenter: new FailurePresenter(),
  });
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let sends = 0, commands = 0;
  const first = intent.submit(
    () => Promise.resolve({ text: "captured" }),
    async (value) => {
      assertEquals(value.text, "captured");
      sends++;
      entered.resolve();
      await held.promise;
    },
  );
  await entered.promise;
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  await intent.submit(() => {
    commands++;
    return Promise.resolve(undefined);
  }, () => {
    throw new Error("Commands do not send");
  });
  await intent.submit(() => Promise.resolve({ text: "new draft" }), () => {
    sends++;
    return Promise.resolve();
  });
  assertEquals(commands, 1);
  assertEquals(sends, 1);
  assertEquals(intent.state.pending, true);
  held.resolve();
  await first;
  assertEquals(intent.state.pending, false);
});
