// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { requireCapability } from "@otk/harness";
import { OperationFailure, type PromptPart } from "@otk/protocol";
import { join } from "@std/path";
import { observationFixture } from "../../../tests/support/error-observations.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";

for (const method of ["prompt", "command"] as const) {
  test(`V1 ${method} preparation rejection borrows one retained record into its HTTP observation`, async () => {
    const f = await observationFixture();
    const requestID = crypto.randomUUID();
    const operation = {
      key: {
        clientID: crypto.randomUUID(),
        key: requestID,
        window: crypto.randomUUID(),
        origin: "api" as const,
      },
      signal: new AbortController().signal,
      progress() {},
      beforeEffect: () => Promise.resolve(),
      checkpoint: () => Promise.resolve(),
    };
    const parts: Extract<PromptPart, { kind: "file" }>[] = [{
      kind: "file",
      source: "path",
      path: join(await tempDir("rejected-attachment-"), "missing.txt"),
    }];
    try {
      const send = method === "prompt"
        ? () =>
          requireCapability(f.adapter.capabilities, "prompt").prompt({
            sessionID: "opcv1-case-a",
            mode: "normal",
            parts,
          }, operation)
        : () =>
          requireCapability(f.adapter.capabilities, "commands").command({
            sessionID: "opcv1-case-a",
            command: "probe",
            arguments: "",
            parts,
          }, operation);
      await assertRejects(send, OperationFailure);
      const { state } = await f.coherent();
      assertEquals(
        f.requests.length,
        0,
        "Preparation failure must not reach native launch",
      );
      assertEquals(state.observations.length, 1);
      const observation = state.observations[0];
      assertEquals(observation.source, "http");
      assertEquals(observation.requestID, requestID);
      assertEquals(
        observation.operation,
        method === "prompt" ? undefined : method,
      );
      assertEquals(observation.eventID, undefined);
      assertEquals(observation.failure?.facts?.origin, "api");
      const records = f.ops.flatMap(({ event }) =>
        event.op === "message.upsert" ? [event.message] : []
      );
      assertEquals(records.length, 1);
      const part = records[0].parts[0];
      assert(part.kind === "external");
      assertEquals(part.failure, observation.failure);
      assertEquals(part.failure?.facts?.record?.messageID, records[0].id);
    } finally {
      await f.stop();
    }
  });
}
