// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createSessionSubmission } from "../session-submission.ts";
import { createSessionDelivery } from "../session-delivery.ts";
import { createTranscriptProjection } from "../transcript-projection.ts";
import type { TranscriptOwner } from "../transcript.ts";
import { RequestFailure } from "../failures.ts";
import { FeedbackFailure } from "../failures.ts";
import { requireCommittedSend } from "../send-outcome.ts";

Deno.test("synchronous source acquisition failure is a closed refusal before native submission", async () => {
  const delivery = createSessionDelivery({
    target: { sidecarId: "server", sessionID: "session" },
    title: () => "Submission",
    transcript: () => {
      throw new RequestFailure({
        code: "source.unavailable",
        diagnosticID: "source",
        retry: "new-intent",
        facts: { reason: "Session source unavailable" },
      });
    },
  });
  let calls = 0;
  const result = await delivery.send(() => {
    calls++;
    return Promise.resolve(null);
  }).catch(() => ({ kind: "threw" }));
  assertEquals(result, {
    kind: "refused",
    reason: "Session source unavailable",
    failure: {
      code: "source.unavailable",
      diagnosticID: "source",
      retry: "new-intent",
      facts: { reason: "Session source unavailable" },
    },
  });
  assertEquals(calls, 0);
  delivery.stop();
});

Deno.test("the composer adapter retains the draft and exposes failed Retry through the existing feedback owner", () => {
  let retries = 0;
  try {
    requireCommittedSend({
      kind: "failed",
      reason: "Native send refused",
      retry: () => retries++,
    });
    throw new Error("A failed send cannot clear a draft");
  } catch (cause) {
    if (!(cause instanceof FeedbackFailure)) throw cause;
    assertEquals(cause.feedback.failure?.reason, "Native send refused");
    assertEquals(cause.feedback.action?.label, "Retry");
    cause.feedback.action?.run();
    assertEquals(retries, 1);
  }
});

for (
  const fault of [
    "none",
    "directory",
    "promotion",
    "wrap",
    "preparation",
    "native",
  ] as const
) {
  Deno.test(`every submission returns one visible outcome after ${fault}`, async () => {
    const projection = createTranscriptProjection();
    projection.merge([{
      id: "native-message",
      sessionID: "session",
      role: "user",
      time: { created: 1 },
      parts: [],
    }]);
    const transcript = {
      projection,
      state: { clock: { epoch: "source", seq: 1 } },
      subscribe: () => () => {},
      pin: () => () => {},
      refetch: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
    } as unknown as TranscriptOwner;
    const delivery = createSessionDelivery({
      target: { sidecarId: "server", sessionID: "session" },
      title: () => "Submission",
      transcript: () => transcript,
    });
    const failure = new RequestFailure({
      code: "submission.test",
      diagnosticID: fault,
      retry: "new-intent",
      facts: { reason: `${fault} refused`, origin: "composer" },
    });
    const fail = (at: typeof fault) => {
      if (fault === at) throw failure;
    };
    const options = {
      sessionID: "session",
      delivery,
      directory: async () => {
        await Promise.resolve();
        fail("directory");
        return "/p";
      },
      tabs: () => ({
        send: async <T>(_id: string, action: () => Promise<T>) => {
          await Promise.resolve();
          fail("promotion");
          return await action();
        },
      }),
      inbox: {
        act: <T>(_directory: string, action: () => Promise<T>) => action(),
      },
      wrap: async <T>(action: () => Promise<T>) => {
        await Promise.resolve();
        fail("wrap");
        return await action();
      },
    };
    const submit = createSessionSubmission(options);
    let draft = "Retained input", count = 0;
    try {
      const result: unknown = await submit(async (...args: unknown[]) => {
        await Promise.resolve();
        fail("preparation");
        (args[1] as (() => void) | undefined)?.();
        await Promise.resolve();
        fail("native");
        return { messageID: "native-message", state: "accepted" as const };
      }).catch(() => ({ kind: "threw" }));
      count++;
      const outcome = result as {
        kind: string;
        messageID?: string;
        reason?: string;
        retry?: () => void;
      };
      if (outcome.kind === "committed") draft = "";
      assertEquals(
        outcome.kind,
        fault === "none"
          ? "committed"
          : fault === "native"
          ? "failed"
          : "refused",
      );
      assertEquals(count, 1);
      assertEquals(draft, fault === "none" ? "" : "Retained input");
      if (fault === "none") assertEquals(outcome.messageID, "native-message");
      else assertEquals(outcome.reason, `${fault} refused`);
      if (fault === "native") assertEquals(typeof outcome.retry, "function");
    } finally {
      delivery.stop();
    }
  });
}
