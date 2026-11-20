// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContextMessage,
  type FailureFacts,
  type PublicFailure,
  publicFailureReason,
} from "@otk/protocol";

/** V1's named HTTP errors have a legacy data envelope. Only selected native
 * user-facing facts cross the diagnostic boundary, never config/response bodies. */
export function requestFailureFacts(
  raw: unknown,
  status?: number,
  credentials: readonly string[] = [],
): FailureFacts {
  const body = object(raw), data = object(body.data ?? body);
  const kind = text(body._tag) ?? text(body.name) ?? "";
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
  const nativeStatus = typeof data.statusCode === "number"
    ? data.statusCode
    : typeof data.status === "number"
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
    ...(/usage limit|quota|insufficient.*(credit|balance)|credit.*(exhaust|limit)|billing/i
        .test(reason)
      ? {
        recovery:
          "Check your provider credits or usage limits, then retry the task.",
      }
      : {}),
  };
}
/** Only V1's task_error payload is classified as a failed helper cause. */
export function helperFailure(
  cause: unknown,
  sessionID: string,
  label: string | undefined,
  recordID: string,
): PublicFailure {
  return {
    code: "helper.failure",
    retry: "none",
    diagnosticID: `helper/${recordID}`,
    facts: {
      actionLabel: "Running helper",
      target: { sessionID, label },
      recovery: "Open the task and retry it.",
      ...requestFailureFacts(cause),
    },
  };
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** This schema is owned by V1 and stored only in its plugin namespace. */
export function requestFailureRecord(
  sessionID: string,
  failure: PublicFailure,
  created = Date.now(),
  replyTo?: string,
  id = `request:failure:${failure.diagnosticID}`,
): ContextMessage {
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
      name: "opencode-v1/request-failure",
      failure,
    }],
  };
}
