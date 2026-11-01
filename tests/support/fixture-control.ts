// SPDX-License-Identifier: LGPL-3.0-only
/** Private test-process protocol. No product imports or runtime-specific APIs. */
export const FIXTURE_PROTOCOL = 1;
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
export type Profile = "ordinary" | "isolated" | "fail-start" | "fail-teardown";
export interface Commands {
  start: { profile: Profile; version: string };
  beginTest: { identity: string };
  endTest: { lease: string };
  queueScript: {
    lease: string;
    chunks: string[];
    gate?: "held" | "stepped";
  };
  releaseGate: { lease: string; gate: string };
  observe: { lease?: string };
  materializeSnapshot: { lease: string; key: string };
  nativeRequest: {
    lease: string;
    path: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: Json;
  };
  productRpc: { lease: string; method: string; params: Json };
  writeProjectFiles: { lease: string; files: Record<string, string> };
  restart: { lease: string; target: "native" };
  stop: Record<string, never>;
}
export type Command = keyof Commands;
export type ControlRequest = {
  [M in Command]: { v: 1; id: string; command: M; params: Commands[M] };
}[Command];
export interface ControlResponse {
  v: 1;
  id: string;
  ok: boolean;
  result?: Json;
  error?: { message: string; stack?: string; causes?: Json[] };
}
export interface StackInfo {
  root: string;
  url: string;
  nativeUrl: string;
  binary: string;
  version: string;
  pids: number[];
  ports: number[];
}
export interface TestLease {
  lease: string;
  directory: string;
  baseline: Record<string, Json>;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 16384) {
    throw new Error("Expected bounded nonempty string");
  }
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown protocol field");
  }
}
export function request(value: unknown): ControlRequest {
  const frame = object(value);
  keys(frame, ["v", "id", "command", "params"]);
  if (frame.v !== FIXTURE_PROTOCOL) {
    throw new Error("Fixture protocol mismatch");
  }
  text(frame.id);
  const p = object(frame.params);
  const fields: Record<Command, string[]> = {
    start: ["profile", "version"],
    beginTest: ["identity"],
    endTest: ["lease"],
    queueScript: ["lease", "chunks", "gate"],
    releaseGate: ["lease", "gate"],
    observe: ["lease"],
    materializeSnapshot: ["lease", "key"],
    nativeRequest: ["lease", "path", "method", "body"],
    productRpc: ["lease", "method", "params"],
    writeProjectFiles: ["lease", "files"],
    restart: ["lease", "target"],
    stop: [],
  };
  if (
    typeof frame.command !== "string" || !Object.hasOwn(fields, frame.command)
  ) {
    throw new Error("Unknown fixture command");
  }
  const command = frame.command as Command;
  keys(p, fields[command]);
  if (!["start", "beginTest", "observe", "stop"].includes(command)) {
    text(p.lease);
  }
  if (command === "observe" && p.lease !== undefined) text(p.lease);
  switch (command) {
    case "start":
      if (
        !["ordinary", "isolated", "fail-start", "fail-teardown"].includes(
          String(p.profile),
        )
      ) {
        throw new Error("Unknown scenario profile");
      }
      if (!/^1\.\d+\.\d+$/.test(String(p.version))) {
        throw new Error("Invalid version");
      }
      break;
    case "beginTest":
      text(p.identity);
      break;
    case "queueScript":
      if (
        !Array.isArray(p.chunks) ||
        !p.chunks.every((s) => typeof s === "string")
      ) {
        throw new Error("Invalid script chunks");
      }
      if (p.gate !== undefined && p.gate !== "held" && p.gate !== "stepped") {
        throw new Error("Invalid script gate");
      }
      break;
    case "releaseGate":
      text(p.gate);
      break;
    case "materializeSnapshot":
      text(p.key);
      break;
    case "nativeRequest":
      text(p.path);
      if (!/^\/(session(?:\/[^?#]*)?|experimental\/tool\/ids)$/.test(p.path)) {
        throw new Error("Native path outside fixture vocabulary");
      }
      if (
        p.method !== undefined &&
        !["GET", "POST", "PATCH", "DELETE"].includes(String(p.method))
      ) {
        throw new Error("Invalid native method");
      }
      break;
    case "productRpc":
      text(p.method);
      break;
    case "writeProjectFiles":
      if (!Object.values(object(p.files)).every((s) => typeof s === "string")) {
        throw new Error("Invalid project files");
      }
      break;
    case "restart":
      if (p.target !== "native") throw new Error("Unknown restart target");
  }
  return frame as unknown as ControlRequest;
}
export function response(value: unknown): ControlResponse {
  const frame = object(value);
  keys(frame, ["v", "id", "ok", "result", "error"]);
  if (frame.v !== FIXTURE_PROTOCOL || typeof frame.ok !== "boolean") {
    throw new Error("Invalid fixture response");
  }
  text(frame.id);
  if (
    frame.ok
      ? frame.error !== undefined
      : typeof object(frame.error).message !== "string"
  ) {
    throw new Error("Invalid fixture outcome");
  }
  return frame as unknown as ControlResponse;
}
