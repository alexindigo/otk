// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { type ContextMessage, isRealPrompt, type Message } from "@otk/protocol";
import {
  createTranscriptProjection,
  replyKey,
} from "../transcript-projection.ts";

Deno.test("failure records retain their declared turn across later prompts and remounts without becoming prompt anchors", () => {
  const prompt: Message = {
    id: "prompt",
    sessionID: "fixture",
    role: "user",
    time: { created: 1 },
    parts: [],
  };
  const next: Message = { ...prompt, id: "next", time: { created: 2 } };
  const failure: ContextMessage = {
    id: "failure",
    sessionID: "fixture",
    role: "context",
    replyTo: prompt.id,
    time: { created: 3 },
    parts: [{
      kind: "external",
      id: "part",
      name: "acme/request-failure",
      failure: {
        code: "acme.rejected",
        retry: "none",
        diagnosticID: "original",
        facts: {
          reason: "Native reason",
          target: { sessionID: "fixture" },
          actionLabel: "Running session",
        },
      },
    }],
  };
  const projection = createTranscriptProjection();
  projection.replace([prompt, next]);
  projection.apply({ op: "message.upsert", message: failure });
  assertEquals(replyKey(failure), "reply:prompt");
  assertEquals(projection.state.repliesByID["reply:prompt"].messageIDs, [
    failure.id,
  ]);
  assertEquals(isRealPrompt(failure), false);
  const serialized = JSON.parse(JSON.stringify(projection.messages()));
  const reloaded = createTranscriptProjection();
  reloaded.replace(serialized);
  assertEquals(reloaded.state.repliesByID["reply:prompt"].messageIDs, [
    failure.id,
  ]);
  assert(!reloaded.state.repliesByID["reply:next"]);
  const unsent = { ...failure, id: "unsent", replyTo: undefined };
  assertEquals(replyKey(unsent), "unsent");
});
