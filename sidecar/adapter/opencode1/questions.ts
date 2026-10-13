// SPDX-License-Identifier: LGPL-3.0-only
import type { QuestionRequest } from "@otk/protocol";
import type { RawQuestion } from "./types.ts";
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
