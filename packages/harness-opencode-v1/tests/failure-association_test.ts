// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { observationFixture } from "../../../tests/support/error-observations.ts";
import { test } from "../../../tests/support/resources.ts";

for (const method of ["shell", "command"] as const) {
  test(`V1 ${method} admission cannot borrow a previous prompt's failure association`, async () => {
    const f = await observationFixture();
    try {
      await f.directPrompt("old-prompt");
      await f.submit(method);
      f.native(
        "New launch failed before any new prompt",
        "case-a",
        "new-launch-failure",
      );
      await f.wait(() =>
        f.ops.some(({ event }) =>
          event.op === "message.upsert" &&
          event.message.parts.some((part) =>
            part.kind === "external" &&
            part.failure?.facts?.reason ===
              "New launch failed before any new prompt"
          )
        )
      );
      const records = f.ops.flatMap(({ event }) =>
        event.op === "message.upsert" &&
          event.message.parts.some((part) =>
            part.kind === "external" &&
            part.failure?.facts?.reason ===
              "New launch failed before any new prompt"
          )
          ? [event.message]
          : []
      );
      assert(records.length > 0);
      for (const record of records) {
        assertEquals(record.role === "context" && record.replyTo, undefined);
      }
    } finally {
      await f.stop();
    }
  });
  test(`V1 ${method} failure may associate with a newly observed native prompt`, async () => {
    const f = await observationFixture();
    try {
      await f.directPrompt("old-prompt");
      await f.submit(method);
      f.send("message.updated", {
        info: {
          id: "current-prompt",
          sessionID: "case-a",
          role: "user",
          time: { created: Date.now() },
        },
      });
      f.send("message.part.updated", {
        part: {
          id: "current-text",
          sessionID: "case-a",
          messageID: "current-prompt",
          type: "text",
          text: "New native prompt",
        },
      });
      await f.wait(() =>
        f.ops.some(({ event }) =>
          event.op === "message.upsert" &&
          event.message.id === "current-prompt" && event.message.role === "user"
        )
      );
      f.native("Failure of the new native prompt", "case-a", "current-failure");
      await f.wait(() =>
        f.ops.some(({ event }) =>
          event.op === "message.upsert" &&
          event.message.parts.some((part) =>
            part.kind === "external" &&
            part.failure?.facts?.reason === "Failure of the new native prompt"
          )
        )
      );
      const records = f.ops.flatMap(({ event }) =>
        event.op === "message.upsert" &&
          event.message.parts.some((part) =>
            part.kind === "external" &&
            part.failure?.facts?.reason === "Failure of the new native prompt"
          )
          ? [event.message]
          : []
      );
      assert(records.length > 0);
      for (const record of records) {
        assertEquals(
          record.role === "context" && record.replyTo,
          "current-prompt",
        );
      }
    } finally {
      await f.stop();
    }
  });
}

test("V1 ordinary session deletion retires failure association and replay identity", async () => {
  const f = await observationFixture();
  try {
    await f.directPrompt("deleted-prompt");
    f.native("Before deletion", "case-a", "same-event");
    await f.wait(() =>
      f.ops.some(({ event }) =>
        event.op === "message.upsert" &&
        event.message.parts.some((part) =>
          part.kind === "external" &&
          part.failure?.facts?.reason === "Before deletion"
        )
      )
    );
    f.remove();
    await f.wait(() => !f.entries.has("opcv1-case-a"));
    f.send("session.created", { info: f.sessions[0] });
    await f.wait(() => f.entries.has("opcv1-case-a"));
    f.adapter.core.subscriptions("opcv1-case-a", 1);
    const before = f.ops.length;
    f.native("After reappearance", "case-a", "same-event");
    await f.wait(() =>
      f.ops.slice(before).some(({ event }) =>
        event.op === "message.upsert" &&
        event.message.parts.some((part) =>
          part.kind === "external" &&
          part.failure?.facts?.reason === "After reappearance"
        )
      )
    );
    const records = f.ops.slice(before).flatMap(({ event }) =>
      event.op === "message.upsert" ? [event.message] : []
    );
    assert(records.length > 0);
    for (const record of records) {
      assertEquals(record.role === "context" && record.replyTo, undefined);
    }
  } finally {
    await f.stop();
  }
});
