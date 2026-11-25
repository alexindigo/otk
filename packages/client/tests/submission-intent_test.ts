// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  createSubmissionIntent,
  FailurePresenter,
  type RequestFailure,
} from "@otk/client";

for (
  const boundary of [
    "before preparation",
    "after preparation",
    "before dispatch",
  ] as const
) {
  Deno.test(`Send readiness loss ${boundary} refuses visibly with its captured target`, async () => {
    let unavailable: string | undefined;
    const intent = createSubmissionIntent<{ text: string }>({
      capture: structuredClone,
      presenter: new FailurePresenter(),
      target: () => ({
        sessionID: "opcv2-ses_send",
        label: "Captured session",
      }),
      unavailable: () => unavailable,
      recovery: () => "Reconnect, then send the retained draft",
    });
    let sends = 0;
    await assertRejects(() =>
      intent.submit(async () => {
        if (boundary === "before preparation") {
          unavailable = "Reconnect to send";
        }
        intent.require();
        await Promise.resolve();
        if (boundary === "after preparation") {
          unavailable = "Reconnect to send";
          intent.require();
        }
        if (boundary === "before dispatch") unavailable = "Reconnect to send";
        return { text: "retained draft" };
      }, () => {
        sends++;
        return Promise.resolve();
      })
    );
    const shown = intent.state.feedback?.failure;
    assertEquals(sends, 0);
    assertEquals(intent.state.pending, false);
    assertEquals(shown?.action, "Sending prompt");
    assertEquals(shown?.value.facts?.target?.label, "Captured session");
    assertEquals(shown?.target, { label: "" });
    assertEquals(shown?.reason, "Reconnect to send");
    assertEquals(shown?.recovery, "Reconnect, then send the retained draft");
  });
}

Deno.test("a refused send during captured submission has visible refusal rather than successful silence", async () => {
  const intent = createSubmissionIntent<{ text: string }>({
    capture: structuredClone,
    presenter: new FailurePresenter(),
  });
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const first = intent.submit(
    () => Promise.resolve({ text: "first" }),
    async () => {
      entered.resolve();
      await held.promise;
    },
  );
  await entered.promise;
  for (let n = 0; n < 8; n++) await Promise.resolve();
  try {
    await assertRejects(() =>
      intent.submit(
        () => Promise.resolve({ text: "retained second draft" }),
        () => Promise.reject(new Error("A refused send cannot dispatch")),
      )
    );
    assertEquals(
      intent.state.feedback?.failure?.reason,
      "Another message is still being sent",
    );
    assertEquals(
      intent.state.feedback?.failure?.recovery,
      "Wait for that send to settle, then send the retained draft",
    );
  } finally {
    held.resolve();
    await first;
  }
});

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
  await assertRejects(() =>
    intent.submit(() => Promise.resolve({ text: "new draft" }), () => {
      sends++;
      return Promise.resolve();
    })
  );
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
    await assertRejects(() => blocked);
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

Deno.test("a refusal citing the captured send retires when that send settles, never earlier", async () => {
  const retired: string[] = [], ready: { reason?: string } = {};
  const intent = createSubmissionIntent<{ text: string }>({
    capture: structuredClone,
    presenter: new FailurePresenter(),
    unavailable: () => ready.reason,
    retire: (id) => retired.push(id),
  });
  const held = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const first = intent.submit(
    () => Promise.resolve({ text: "first" }),
    async () => {
      entered.resolve();
      await held.promise;
    },
  );
  await entered.promise;
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  const refused = await intent.submit(
    () => Promise.resolve({ text: "second" }),
    () => Promise.reject(new Error("A refused send cannot dispatch")),
  ).then(() => undefined, (cause) => cause as RequestFailure);
  assertEquals(
    refused?.failure.facts?.reason,
    "Another message is still being sent",
  );
  assertEquals(retired, []);
  held.resolve();
  await first;
  assertEquals(retired, [refused!.failure.diagnosticID]);
  // Readiness refusal does not cite a captured send; it stays the user's to resolve.
  ready.reason = "Reconnect first";
  await assertRejects(() =>
    intent.submit(
      () => Promise.resolve({ text: "third" }),
      () => Promise.resolve(),
    )
  );
  await Promise.resolve();
  assertEquals(retired, [refused!.failure.diagnosticID]);
});
