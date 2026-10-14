// SPDX-License-Identifier: LGPL-3.0-only
import {
  belongsToSession,
  type IndexEntry,
  type QuestionRequest,
} from "@otk/protocol";
import { HarnessError, type QuestionsCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { RawQuestion } from "./types.ts";
export function questions(
  client: Client,
  directory: Directory,
  entry: (id: string) => IndexEntry | undefined,
  owners: Map<string, string>,
): QuestionsCapability {
  return {
    async listQuestions(sessionID) {
      const pending = await client.json<RawQuestion[]>("/question", {
        query: { directory: await directory.resolve(sessionID) },
      });
      for (const request of pending) owners.set(request.id, request.sessionID);
      return pending.filter((request) =>
        belongsToSession(request.sessionID, sessionID, entry)
      ).map(mapQuestion).sort((a, b) => a.id.localeCompare(b.id));
    },
    async answerQuestion(requestID, answers) {
      const owner = owners.get(requestID);
      if (!owner) {
        throw new HarnessError("question", "Question is no longer pending");
      }
      const dir = await directory.resolve(owner);
      if (answers) {
        const request = (await client.json<RawQuestion[]>("/question", {
          query: { directory: dir },
        })).find((q) => q.id === requestID);
        if (!request) {
          throw new HarnessError("question", "Question is no longer pending");
        }
        if (
          answers.length !== request.questions.length ||
          answers.some((values, i) =>
            (!request.questions[i].multiple && values.length > 1) ||
            (request.questions[i].custom === false &&
              values.some((value) =>
                !request.questions[i].options.some((option) =>
                  option.label === value
                )
              ))
          )
        ) throw new HarnessError("params", "Invalid question answers");
      }
      await client.json(
        `/question/${encodeURIComponent(requestID)}/${
          answers ? "reply" : "reject"
        }`,
        {
          method: "POST",
          query: { directory: dir },
          ...(answers ? { body: { answers } } : {}),
        },
      );
    },
  };
}
export function mapQuestion(raw: RawQuestion): QuestionRequest {
  return {
    id: raw.id,
    sessionID: raw.sessionID,
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
