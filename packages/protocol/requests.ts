// SPDX-License-Identifier: LGPL-3.0-only
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
export interface PublicFailure {
  code: string;
  retry: "same-intent" | "new-intent" | "none";
  field?: string;
  diagnosticID: string;
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
/** Open metadata vocabulary; features contribute explicit allowlisted records. */
// deno-lint-ignore no-empty-interface -- Declaration-mergeable feature receipt vocabulary.
export interface RequestReceipts {}
export type ReceiptData = {
  [K in keyof RequestReceipts]: { kind: K; value: RequestReceipts[K] };
}[keyof RequestReceipts];
export interface OperationContext {
  readonly signal: AbortSignal;
  readonly key: Readonly<IntentIdentity>;
  progress(value: RequestProgress): void;
  beforeEffect(): Promise<void>;
  checkpoint(kind: string, receipt: ReceiptData): Promise<void>;
  /** Yield interactive scheduling pressure while readiness/I/O is outstanding. */
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
