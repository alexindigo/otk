// SPDX-License-Identifier: LGPL-3.0-only
/** Diagnostics must not turn an accepted primary operation into a rejection. */
export function reportDiagnostic(
  report: (error: unknown) => void,
  error: unknown,
): void {
  try {
    report(error);
  } catch (reportError) {
    console.error(
      "Diagnostic reporting failed",
      new AggregateError([
        error,
        reportError,
      ]),
    );
  }
}
