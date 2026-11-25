// SPDX-License-Identifier: LGPL-3.0-only
/** Scalar Send breadcrumbs. The native message ID joins these to content receipts. */
export function sendDiagnostic(
  stage: "activation" | "admitted" | "refused" | "dispatch" | "receipt",
  fields: {
    activation?: string;
    messageID?: string;
    request?: string;
    state?: string;
  },
): void {
  console.debug(
    "OTK send receipt",
    JSON.stringify({ stage, ...fields, at: Date.now() }),
  );
}

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
