// SPDX-License-Identifier: LGPL-3.0-only
import type { QuestionRequest, SessionLookup } from "@otk/protocol";
import { HarnessError, type QuestionsCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { RawQuestion } from "./types.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import type { PendingQuestions } from "./pending-questions.ts";

export function questions(
  client: Client,
  directory: Directory,
  entry: SessionLookup,
  pending: PendingQuestions,
  inventory?: (directory: string, signal?: AbortSignal) => Promise<unknown>,
): QuestionsCapability {
  const ensure = async (dir: string, signal?: AbortSignal) => {
    if (pending.known(dir)) return;
    if (inventory) {
      await inventory(dir, signal);
      return;
    }
    for (;;) {
      const capture = pending.capture(dir);
      try {
        const values = (await client.json<RawQuestion[]>("/question", {
          query: { directory: dir },
          signal,
        })).map(mapQuestion);
        signal?.throwIfAborted();
        if (capture.commit(values)) return;
      } finally {
        capture.release();
      }
    }
  };
  return {
    async listQuestions(sessionID, signal) {
      const dir = await directory.resolve(sessionID, signal);
      await ensure(dir, signal);
      return pending.list(sessionID, entry);
    },
    async answerQuestion(requestID, answers, operation) {
      const original = pending.get(requestID);
      if (!original) {
        throw new HarnessError("question", "Question is no longer pending");
      }
      const askingDirectory = original.directory ??
        await directory.resolve(original.request.sessionID, operation?.signal);
      await ensure(askingDirectory, operation?.signal);
      const current = pending.get(requestID);
      if (
        !current || current.generation !== original.generation ||
        current.directory !== askingDirectory
      ) throw new HarnessError("question", "Question is no longer pending");
      const request = current.request;
      if (
        answers &&
        (answers.length !== request.questions.length ||
          answers.some((values, i) =>
            (!request.questions[i].multiple && values.length > 1) ||
            (!request.questions[i].custom &&
              values.some((value) =>
                !request.questions[i].options.some((option) =>
                  option.label === value
                )
              ))
          ))
      ) throw new HarnessError("params", "Invalid question answers");
      await client.json(
        `/question/${encodeURIComponent(requestID)}/${
          answers ? "reply" : "reject"
        }`,
        {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory: current.directory },
          ...(answers ? { body: { answers } } : {}),
        },
      );
    },
  };
}
export function mapQuestion(raw: RawQuestion): QuestionRequest {
  return {
    id: raw.id,
    sessionID: ids.encode(raw.sessionID),
    questions: raw.questions.map((q) => ({
      header: q.header,
      text: q.question,
      options: q.options.map(({ label, description }) => ({
        label,
        description,
      })),
      multiple: q.multiple === true,
      custom: q.custom !== false,
    })),
  };
}
