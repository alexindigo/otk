// SPDX-License-Identifier: LGPL-3.0-only
/** Source facts, never an invented percentage or deadline. Null total is unknown. */
export interface ProgressFacts {
  generation: string;
  directory?: string;
  phase: "enumerating" | "summaries" | "ready" | "reading" | "queued";
  eligible: number | null;
  completed: number;
  queued: number;
  chunks: number;
  messages: number;
  activeMs: number;
  started: number;
  advanced: number;
  wait?: string;
}
