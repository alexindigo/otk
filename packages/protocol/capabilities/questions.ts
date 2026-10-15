// SPDX-License-Identifier: LGPL-3.0-only
import type { QuestionRequest } from "../content.ts";
export interface QuestionsCapability {
  listQuestions(sessionID: string): Promise<QuestionRequest[]>;
  answerQuestion(requestID: string, answers?: string[][]): Promise<void>;
}
export interface QuestionsCapabilities {
  questions: QuestionsCapability;
}
export const legacyQuestionsCapabilities:
  readonly (keyof QuestionsCapabilities)[] = ["questions"];
