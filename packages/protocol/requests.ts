// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxRequestReceipts } from "./inbox.ts";
import type { PreferencesRequestReceipts } from "./prefs.ts";
import type { FrecencyRequestReceipts } from "./frecency.ts";
import type { ApprovalRequestReceipts } from "./approvals.ts";
import type { CoreRequestReceipts } from "./rpc.ts";
import type { SessionActionsRequestReceipts } from "./capabilities/session-actions.ts";
import { isSessionID } from "./session-id.ts";
/** Additive request services. Wire composition selects these at activation. */
export interface RequestWindow {
  id: string;
  expiresAt: number;
}
export interface IntentIdentity {
  clientID: string;
  key: string;
  window: string;
}
export interface RequestRef extends IntentIdentity {
  id: string;
}
export type RequestPhase = "queued" | "running" | "waiting" | "reconciling";
export type ProgressCode =
  | "queued"
  | "working"
  | "stopping"
  | "publishing"
  | "backend-unavailable"
  | "checking-outcome"
  | "input-required";
export interface RequestProgress {
  phase: RequestPhase;
  code: ProgressCode;
  completed?: number;
  total?: number;
}
export interface FailureTarget {
  sidecarId?: string;
  sessionID?: string;
  directory?: string;
  label?: string;
}
/** Producer-selected public facts, never request bodies or raw exception data. */
export interface FailureFacts {
  action?: string;
  target?: FailureTarget;
  reason?: string;
  status?: number;
  recovery?: string;
  outcome?: "unknown" | "unavailable" | "rejected";
}
/** Capture only routing facts, never the request input or an invalid identity. */
export function requestFailureFacts(
  action: string,
  params: unknown,
  sidecarId?: string,
): FailureFacts {
  const fields = params && typeof params === "object"
    ? params as Record<string, unknown>
    : {};
  return {
    action,
    target: {
      ...(sidecarId ? { sidecarId } : {}),
      ...(typeof fields.sessionID === "string" && isSessionID(fields.sessionID)
        ? { sessionID: fields.sessionID }
        : {}),
      ...(typeof fields.directory === "string"
        ? { directory: fields.directory }
        : {}),
    },
  };
}
export interface PublicFailure {
  code: string;
  retry: "same-intent" | "new-intent" | "none";
  field?: string;
  diagnosticID: string;
  facts?: FailureFacts;
}
export type RequestEvent<R = unknown> =
  | {
    t: "request.accepted";
    ref: RequestRef;
    seq: number;
    acceptedAt: number;
    retentionUntil: number;
    replayed: boolean;
  }
  | {
    t: "request.progress";
    ref: RequestRef;
    seq: number;
    progress: RequestProgress;
  }
  | {
    t: "request.result";
    ref: RequestRef;
    seq: number;
    outcome: { ok: true; result: R } | { ok: false; error: PublicFailure };
  }
  | { t: "request.rejected"; ref: RequestRef; error: PublicFailure };
export type RequestControl =
  | { t: "request"; ref: RequestRef; method: string; params: unknown }
  | { t: "request.resume"; items: { ref: RequestRef; after: number }[] }
  | { t: "request.release"; refs: RequestRef[] }
  | { t: "request.received"; refs: { ref: RequestRef; seq: number }[] };
export interface RequestPolicy {
  windowms: number;
  retentionms: number;
  maxpending: number;
  inputbytes: number;
  resultbytes: number;
  resumebatch: number;
  sweepbatch: number;
  livenessms: number;
  stoppingms: number;
}
export interface ClientRequestPolicy {
  livenessms: number;
  stoppingms: number;
  httpms: number;
  pingms: number;
  silencems: number;
  retrybase: number;
  retrymax: number;
  resumebatch: number;
  maxpending: number;
  inputbytes: number;
}
export function clientRequestPolicyFrom(value: unknown): ClientRequestPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid request policy");
  }
  const policy = value as ClientRequestPolicy;
  const fields = [
    "livenessms",
    "stoppingms",
    "httpms",
    "pingms",
    "silencems",
    "retrybase",
    "retrymax",
    "resumebatch",
    "maxpending",
    "inputbytes",
  ] as const;
  if (
    Object.keys(policy).length !== fields.length ||
    fields.some((field) =>
      !Number.isSafeInteger(policy[field]) || policy[field] <= 0
    ) || policy.retrymax < policy.retrybase || policy.silencems <= policy.pingms
  ) throw new TypeError("Invalid request policy");
  return {
    livenessms: policy.livenessms,
    stoppingms: policy.stoppingms,
    httpms: policy.httpms,
    pingms: policy.pingms,
    silencems: policy.silencems,
    retrybase: policy.retrybase,
    retrymax: policy.retrymax,
    resumebatch: policy.resumebatch,
    maxpending: policy.maxpending,
    inputbytes: policy.inputbytes,
  };
}
/** Open metadata vocabulary; features contribute explicit allowlisted records. */
export interface RequestReceipts
  extends
    InboxRequestReceipts,
    PreferencesRequestReceipts,
    FrecencyRequestReceipts,
    ApprovalRequestReceipts,
    CoreRequestReceipts,
    SessionActionsRequestReceipts {}
export type ReceiptData = {
  [K in keyof RequestReceipts]: { kind: K; value: RequestReceipts[K] };
}[keyof RequestReceipts];
export interface OperationContext {
  readonly signal: AbortSignal;
  readonly key: Readonly<IntentIdentity>;
  progress(value: RequestProgress): void;
  beforeEffect(): Promise<void>;
  checkpoint(kind: string, receipt: ReceiptData): Promise<void>;
  /** Yield execution/interactive pressure, then re-queue when readiness/I/O settles. */
  wait?<T>(readiness: Promise<T>): Promise<T>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requestRef(value: unknown, bootstrap = false): RequestRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid request reference");
  }
  const ref = value as Record<string, unknown>;
  if (
    Object.keys(ref).length !== 4 ||
    ["id", "key", "clientID", "window"].some((name) =>
      typeof ref[name] !== "string" ||
      !(name === "window" && bootstrap && ref[name] === "bootstrap") &&
        !uuid.test(ref[name] as string)
    )
  ) throw new TypeError("Invalid request reference");
  return {
    id: ref.id as string,
    key: ref.key as string,
    clientID: ref.clientID as string,
    window: ref.window as string,
  };
}
/** Equality representation, never a persisted input/body. */
export function canonicalRequest(value: unknown): string {
  const seen = new Set<object>();
  const encode = (value: unknown): string => {
    if (
      value === null || typeof value === "boolean" || typeof value === "string"
    ) return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      return JSON.stringify(value);
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      throw new TypeError("Expected JSON request parameters");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) {
          throw new TypeError("Sparse request array");
        }
        return "[" + value.map(encode).join(",") + "]";
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) throw new TypeError("Expected plain request object");
      return "{" + Object.keys(value).sort().map((key) =>
        JSON.stringify(key) + ":" +
        encode((value as Record<string, unknown>)[key])
      ).join(",") + "}";
    } finally {
      seen.delete(value);
    }
  };
  return encode(value);
}
export async function requestFingerprint(canonical: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
