// SPDX-License-Identifier: LGPL-3.0-only
import type { ReportedTokens } from "@otk/protocol";
export function reportedNumber(value: unknown, integral = true): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER &&
      (!integral || Number.isSafeInteger(value))
    ? value
    : null;
}
export function reportedTokens(
  value?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  },
): ReportedTokens {
  return {
    input: reportedNumber(value?.input),
    output: reportedNumber(value?.output),
    reasoning: reportedNumber(value?.reasoning),
    cache: {
      read: reportedNumber(value?.cache?.read),
      write: reportedNumber(value?.cache?.write),
    },
  };
}
