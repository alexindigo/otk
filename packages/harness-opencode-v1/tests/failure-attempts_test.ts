// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { requireCapability } from "@otk/harness";
import type { ContextMessage, Message, PublicFailure } from "@otk/protocol";
import { observationFixture } from "../../../tests/support/error-observations.ts";
import { test } from "../../../tests/support/resources.ts";

type Fixture = Awaited<ReturnType<typeof observationFixture>>;
function records(f: Fixture): Message[] {
  const rows = new Map<string, Message>();
  for (const { event } of f.ops) {
    if (
      event.op === "message.upsert" &&
      event.message.parts.some((part) =>
        part.kind === "external" && part.failure
      )
    ) rows.set(event.message.id, event.message);
  }
  return [...rows.values()];
}
function failure(row: Message): PublicFailure {
  const part = row.parts.find((part) =>
    part.kind === "external" && part.failure
  );
  assert(part?.kind === "external" && part.failure);
  return part.failure;
}
async function native(f: Fixture, reason: string, eventID: string) {
  f.native(reason, "case-a", eventID);
  await f.wait(() =>
    f.ops.some(({ event }) =>
      event.op === "session.error" &&
      event.errorState?.observations.some((o) => o.eventID === eventID) === true
    )
  );
}
async function http(f: Fixture, index: number) {
  f.fail(index, "An HTTP-only failed attempt", `http-${index}`);
  await f.wait(() =>
    f.ops.some(({ event }) =>
      event.op === "session.error" &&
      event.errorState?.observations.some((o) => o.ref === `http-${index}`) ===
        true
    )
  );
}
for (const method of ["shell", "command"] as const) {
  test(`${method} failure attempt: unlinked reports preserve arrival order with equal clocks`, async () => {
    const f = await observationFixture();
    const now = Date.now;
    try {
      await f.submit(method);
      const clock = now();
      Date.now = () => clock;
      await http(f, 0);
      await native(f, "An independent native failure", "equal-clock-native");
      const rows = records(f);
      assertEquals(rows.length, 2);
      assert(
        rows[0].time.created < rows[1].time.created,
        "Independent reports need stable arrival order, not random identity order",
      );
      assertEquals(failure(rows[0]).facts?.status, 503);
      assertEquals(failure(rows[1]).facts?.status, undefined);
    } finally {
      Date.now = now;
      await f.stop();
    }
  });
  test(`${method} failure attempt: first native report closes admission while HTTP is pending`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      await native(f, "The launched native failed", "first-terminal");
      const first = structuredClone(records(f)[0]);
      assertEquals(failure(first).facts?.origin, undefined);
      await native(f, "An independent native failure", "independent-terminal");
      assertEquals(records(f).length, 2);
      assertEquals(records(f).find((row) => row.id === first.id), first);
      await http(f, 0);
      assertEquals(records(f).length, 2);
      assertEquals(
        failure(records(f).find((row) => row.id === first.id)!).facts?.status,
        503,
      );
      assertEquals(failure(records(f)[1]).facts?.status, undefined);
      assertEquals(failure(records(f)[1]).facts?.origin, undefined);
    } finally {
      await f.stop();
    }
  });
  test(`${method} failure attempt: replay after a new prompt cannot consume the new attempt`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      await native(f, "Original native error", "original-event");
      await http(f, 0);
      const original = structuredClone(records(f)[0]);
      await f.directPrompt("new-prompt-after-settlement");
      await native(f, "Original native error", "original-event");
      await native(f, "New prompt error", "new-prompt-event");
      assertEquals(records(f).length, 2);
      assertEquals(records(f).find((row) => row.id === original.id), original);
      assertEquals(
        (records(f)[1] as ContextMessage).replyTo,
        "new-prompt-after-settlement",
      );
    } finally {
      await f.stop();
    }
  });
  test(`${method} failure attempt: HTTP failure closes eligibility for an unrelated native error`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      await http(f, 0);
      const original = structuredClone(records(f)[0]);
      await native(f, "An unrelated native failure", "unrelated-native");
      assertEquals(records(f).length, 2);
      assertEquals(records(f).find((row) => row.id === original.id), original);
      assertEquals((records(f)[1] as ContextMessage).replyTo, undefined);
      assertEquals(failure(records(f)[0]).facts?.origin, undefined);
      assertEquals(failure(records(f)[1]).facts?.origin, undefined);
    } finally {
      await f.stop();
    }
  });
  test(`${method} failure attempt: reports after the first native error update one settled record`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      await native(f, "Readable native failure", "native-first");
      const id = records(f)[0].id;
      await http(f, 0);
      await native(f, "Readable native failure", "native-repeat");
      await native(f, "Cause: Readable native failure", "native-cause");
      assertEquals(records(f).map((row) => row.id), [id]);
      assertEquals(failure(records(f)[0]).facts?.status, 503);
      assert(
        failure(records(f)[0]).facts?.reason?.includes(
          "Readable native failure",
        ),
      );
      await f.submit(method);
      await native(
        f,
        "A different attempt's native failure",
        "native-new-attempt",
      );
      assertEquals(records(f).length, 2);
      assert(records(f)[1].id !== id);
    } finally {
      await f.stop();
    }
  });
  test(`${method} failure attempt: a later direct prompt after HTTP-only failure owns its own record`, async () => {
    const f = await observationFixture();
    try {
      await f.submit(method);
      await http(f, 0);
      const original = structuredClone(records(f)[0]);
      await f.directPrompt("later-direct-prompt");
      await native(f, "The later prompt failed", "later-prompt-error");
      assertEquals(records(f).length, 2);
      assertEquals(records(f).find((row) => row.id === original.id), original);
      const later = records(f).find((row) =>
        row.id !== original.id
      ) as ContextMessage;
      assertEquals(later.replyTo, "later-direct-prompt");
      assertEquals(failure(later).facts?.reason, "The later prompt failed");
    } finally {
      await f.stop();
    }
  });
  test(`${method} failure attempt: cancellation retires pending and settled eligibility`, async () => {
    const f = await observationFixture();
    try {
      f.allowLateResponse();
      await f.submit(method);
      await requireCapability(f.adapter.capabilities, "prompt").abort(
        "opcv1-case-a",
      );
      const count = records(f).length;
      await native(f, "After cancellation", "cancelled-late-error");
      const record = records(f).at(-1)!;
      assertEquals(records(f).length, count + 1);
      assert(!record.id.includes("launch:"));
      await f.submit(method);
      await native(f, "Settled before cancel", "before-cancel");
      const settled = records(f).at(-1)!.id;
      await requireCapability(f.adapter.capabilities, "prompt").abort(
        "opcv1-case-a",
      );
      await native(f, "Settled before cancel", "new-after-cancel");
      assert(records(f).at(-1)!.id !== settled);
    } finally {
      await f.stop();
    }
  });
}
