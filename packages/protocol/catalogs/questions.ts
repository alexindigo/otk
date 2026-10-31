// SPDX-License-Identifier: LGPL-3.0-only
import type { QuestionRequest } from "../content.ts";
import { arrayCatalogCodec } from "./arrays.ts";
export interface QuestionCatalogKinds {
  questions: QuestionRequest[];
}
export interface QuestionChunkKinds {
  questions: QuestionRequest;
}
export const questionsCatalogCodec = arrayCatalogCodec<"questions">();
