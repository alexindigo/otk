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

for (const mode of ["normal", "shell", "command"] as const) {
  Deno.test(`a ${mode} draft entered during Sending cannot become a send after preparation`, async () => {
    const intent = createSubmissionIntent<{ text: string; mode: string }>({
      capture: structuredClone,
      presenter: new FailurePresenter(),
    });
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      preparing = Promise.withResolvers<void>(),
      ready = Promise.withResolvers<void>();
    const requests: { text: string; mode: string }[] = [];
    let draft = { text: "first prompt", mode: "normal" };
    const first = intent.submit(
      () => Promise.resolve(draft),
      async (captured) => {
        requests.push(captured);
        entered.resolve();
        await held.promise;
      },
    );
    await entered.promise;
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    // Input commands remain usable while the captured native send settles.
    await intent.submit(() => {
      draft = { text: "", mode };
      return Promise.resolve(undefined);
    }, () => {
      throw new Error("Entering a mode must not send");
    });
    draft = { text: "newer draft", mode };
    const submit = () =>
      intent.submit(async () => {
        preparing.resolve();
        await ready.promise;
        return draft;
      }, (captured) => {
        requests.push(captured);
        return Promise.resolve();
      });
    const blocked = submit();
    await preparing.promise;
    held.resolve();
    await first;
    ready.resolve();
    await blocked;
    assertEquals(requests, [{ text: "first prompt", mode: "normal" }]);
    assertEquals(draft, { text: "newer draft", mode });
    assertEquals(intent.state.pending, false);
    // Only a fresh, explicit activation may send the preserved newer draft.
    await submit();
    assertEquals(requests, [
      { text: "first prompt", mode: "normal" },
      { text: "newer draft", mode },
    ]);
  });
}
