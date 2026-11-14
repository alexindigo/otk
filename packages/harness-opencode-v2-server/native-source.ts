// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  type Message,
  type NativeSource,
  type Part,
  referenceSources,
} from "@otk/protocol";

/** Native objects have no wire spelling after SDK decoding. Stable key order
 * makes snapshot and event projections inspect identically; arrays stay ordered. */
function stable(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
        : value,
  ) ?? "";
}
export function nativeSource(
  kind: string,
  value: unknown,
  payload?: string,
): NativeSource {
  const source = stable(value),
    bytes = new TextEncoder().encode(source),
    limit = 16384;
  return {
    kind: `opencode-v2/${kind}`,
    preview: new TextDecoder().decode(bytes.subarray(0, limit), {
      stream: bytes.length > limit,
    }),
    bytes: bytes.length,
    truncated: bytes.length > limit,
    payload: payload ?? source,
  };
}
/** V2 owns its source reference format: the derivation origin and location. */
export interface V2SourceRef {
  origin: "message" | "request" | "inbox";
  id: string;
  path: string;
}
export function sourceRef(value: V2SourceRef): string {
  return "v2:" + btoa(JSON.stringify([value.origin, value.id, value.path]))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function parseSourceRef(ref: string): V2SourceRef {
  try {
    if (!ref.startsWith("v2:")) throw new Error();
    const [origin, id, path] = JSON.parse(
      atob(ref.slice(3).replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !["message", "request", "inbox"].includes(origin) ||
      typeof id !== "string" || !id || typeof path !== "string"
    ) throw new Error();
    return { origin, id, path };
  } catch {
    throw new TypeError("Invalid V2 source reference");
  }
}
const REQUEST = "request:";
/** Loaded items reference the owner that can derive their source again. */
export function referenced<T extends Message | Part>(
  value: T,
  messageID: string,
): T {
  return referenceSources(value, (path) =>
    sourceRef(
      messageID.startsWith(REQUEST)
        ? { origin: "request", id: messageID.slice(REQUEST.length), path }
        : { origin: "message", id: messageID, path },
    ));
}
const sourceFailures = {
  reference: [
    "This source reference is no longer valid",
    "Reload the conversation, then open Source again",
  ],
  request: [
    "The retained request outcome no longer exists",
    "This record's source is no longer available",
  ],
  inbox: [
    "This queued item has left the inbox",
    "Its source is in the conversation once it is admitted",
  ],
  message: [
    "The native message for this record no longer exists",
    "This record's source is no longer available",
  ],
  item: [
    "The native message no longer contains this record",
    "This record's source is no longer available",
  ],
  unreachable: ["opencode is not reachable", "Retry"],
  read: ["opencode could not return the native message", "Retry"],
} as const;
/** V2 says why a Source read failed, in words a person can act on. */
export function sourceFailure(kind: keyof typeof sourceFailures): HarnessError {
  const [reason, recovery] = sourceFailures[kind];
  return new HarnessError(`source.${kind}`, reason, { reason, recovery });
}
