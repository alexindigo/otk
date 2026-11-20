// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContextMessage,
  type FailureFacts,
  type PublicFailure,
  publicFailureReason,
} from "@otk/protocol";

/** V2 owns both tagged HTTP errors and legacy named errors from config. Raw
 * response/config bodies remain diagnostic, not Source or public record data. */
export function requestFailureFacts(
  raw: unknown,
  status?: number,
  credentials: readonly string[] = [],
): FailureFacts {
  const body = object(raw), data = object(body.data ?? body);
  const kind = text(body.type) ?? text(body._tag) ?? text(body.name) ?? "";
  const lines = [text(raw) ?? text(data.message)];
  if (/ModelNotFound/.test(kind)) {
    lines.push(
      `Model not found: ${text(data.providerID) ?? ""}/${
        text(data.modelID) ?? ""
      }`,
    );
    const suggestions = Array.isArray(data.suggestions)
      ? data.suggestions.filter((value): value is string =>
        typeof value === "string"
      )
      : [];
    if (suggestions.length) {
      lines.push(`Did you mean: ${suggestions.join(", ")}`);
    }
  }
  if (/Config/.test(kind)) {
    if (text(data.path)) lines.push(`Config path: ${data.path}`);
    if (Array.isArray(data.issues)) {
      for (const issue of data.issues) {
        const value = object(issue);
        if (text(value.message)) {
          lines.push(
            `${
              Array.isArray(value.path) && value.path.length
                ? value.path.filter((part): part is string =>
                  typeof part === "string"
                ).join(".") + ": "
                : ""
            }${value.message}`,
          );
        }
      }
    }
  }
  const nativeStatus = typeof data.status === "number"
    ? data.status
    : undefined;
  const httpStatus = status ?? nativeStatus;
  const reason = publicFailureReason(
    lines.filter(Boolean).join("\n") ||
      (status === undefined
        ? "Native operation failed"
        : `Opencode request failed (${status}).`),
    credentials,
  );
  return {
    reason,
    ...(httpStatus === undefined ? {} : { status: httpStatus }),
    ...(kind === "provider.quota" ||
        /usage limit|quota|insufficient.*(credit|balance)|credit.*(exhaust|limit)|billing/i
          .test(reason)
      ? {
        recovery: kind === "provider.quota"
          ? "Check your provider quota or choose another available model, then send a new prompt."
          : "Check your provider credits or usage limits, then retry the task.",
      }
      : {}),
  };
}
/** The producer's error envelope is the cause, not arbitrary result prose. */
export function helperFailure(
  cause: unknown,
  sessionID: string | undefined,
  label: string | undefined,
  recordID: string,
): PublicFailure {
  const facts = requestFailureFacts(cause);
  return {
    code: "helper.failure",
    retry: "none",
    diagnosticID: `helper/${recordID}`,
    facts: {
      actionLabel: "Running helper",
      target: { sessionID, label },
      recovery: "Open the task and retry it.",
      ...facts,
    },
  };
}
/** Scalar terminal acquisition uses the same public native-cause codec as events. */
export function terminalFailure(
  raw: unknown,
  sessionID: string,
  terminal: number,
  label?: string,
): PublicFailure | undefined {
  if (!raw || !terminal) return;
  return {
    code: "session.failure",
    retry: "none",
    diagnosticID: `execution/${sessionID}/${terminal}`,
    facts: {
      actionLabel: "Running session",
      target: { sessionID, label },
      ...requestFailureFacts(raw),
    },
  };
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** V2's retained request owner supplies its normal chronological position. */
export function requestFailureRecord(
  sessionID: string,
  failure: PublicFailure,
  created = Date.now(),
  replyTo?: string,
): ContextMessage {
  const id = `request:failure:${failure.diagnosticID}`;
  failure = {
    ...failure,
    facts: {
      ...failure.facts,
      record: {
        messageID: id,
        label: failure.facts?.action === "session.prompt" &&
            failure.facts.outcome === "rejected"
          ? "Not sent - see the error above"
          : "See the error above",
      },
    },
  };
  return {
    id,
    sessionID,
    role: "context",
    ...(replyTo ? { replyTo } : {}),
    time: { created },
    parts: [{
      kind: "external",
      id: `${id}:failure`,
      name: "opencode-v2/request-failure",
      failure,
    }],
  };
}
