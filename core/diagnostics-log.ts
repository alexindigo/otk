// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DiagnosticSink,
  errorMessage,
  isCancellation,
  type LogLevel,
} from "@otk/protocol";

const levels: Record<LogLevel, number> = { warn: 0, info: 1, debug: 2 };
/** One output boundary for level selection, cancellation and repeated failures. */
export function diagnosticsLog(
  level: LogLevel,
  write: (level: LogLevel, line: string) => void = (level, line) =>
    console[level](line),
): DiagnosticSink {
  const reported = new WeakSet<object>();
  const sink: DiagnosticSink = (severity, message, cause) => {
    if (levels[severity] > levels[level] || isCancellation(cause)) return;
    if (cause instanceof AggregateError) {
      for (const error of cause.errors) sink(severity, message, error);
      return;
    }
    if (severity === "warn" && cause instanceof Error) {
      if (reported.has(cause)) return;
      reported.add(cause);
    }
    write(
      severity,
      cause === undefined ? message : `${message}: ${errorMessage(cause)}`,
    );
  };
  return sink;
}
