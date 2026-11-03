// SPDX-License-Identifier: LGPL-3.0-only
/** Private test-process protocol. No product imports or runtime-specific APIs. */
export const FIXTURE_PROTOCOL = 1;
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
export type Profile =
  | "ordinary"
  | "composer-pickers"
  | "composer-applied"
  | "composer-selection"
  | "composer-plan"
  | "composer-commands"
  | "composer-mentions"
  | "composer-submission"
  | "composer-required"
  | "composer-catalog"
  | "composer-native-default"
  | "composer-long-command"
  | "composer-history"
  | "composer-shell-failure"
  | "contract-composer-missing"
  | "contract-composer-none"
  | "contract-composer-pending-choice"
  | "contract-composer-failed-variant"
  | "contract-composer-native-null"
  | "messages-native"
  | "messages-tools"
  | "messages-cooling"
  | "messages-files"
  | "messages-context"
  | "messages-temperature"
  | "messages-helper-pages"
  | "messages-recovery"
  | "messages-recovery-retry"
  | "messages-forms"
  | "messages-tool-states"
  | "messages-priced"
  | "isolated"
  | "provider-hold"
  | "transport-page"
  | "transport-deleted-seen"
  | "transport-shell"
  | "transport-freeze"
  | "transport-bootstrap"
  | "transport-errors-http"
  | "transport-errors-late"
  | "transport-enrichment"
  | "transport-cooling"
  | "transport-restart"
  | "contract-core"
  | "contract-messages-highlight"
  | "contract-messages-facts"
  | "contract-messages-metadata"
  | "contract-messages-usage3"
  | "contract-messages-usage120"
  | "contract-messages-usage500"
  | "contract-messages-context"
  | "contract-messages-collapse"
  | "contract-messages-labels"
  | "contract-messages-labels-picker"
  | "contract-messages-money"
  | "contract-messages-window"
  | "contract-messages-anchor"
  | "contract-messages-diff"
  | "contract-messages-disclosures"
  | "contract-messages-usage-paging"
  | "contract-messages-usage-unknown"
  | "contract-messages-usage-queued"
  | "contract-messages-usage-priced"
  | "contract-messages-usage-unreported"
  | "contract-messages-session-cost"
  | "contract-messages-reading"
  | "contract-messages-public-ui"
  | "contract-messages-recorded-files"
  | "contract-messages-recorded-tools"
  | "contract-messages-clock"
  | "contract-reconnect"
  | "contract-initial-question"
  | "contract-permission-feedback"
  | "contract-question-feedback"
  | "contract-task-pending"
  | "contract-task-background"
  | "contract-rpc"
  | "fail-start"
  | "fail-teardown";
export interface Commands {
  start: { profile: Profile; version: string };
  beginTest: { identity: string };
  endTest: { lease: string };
  queueScript: {
    lease: string;
    chunks: string[];
    gate?: "held" | "stepped";
    delay?: number;
    tool?: { name: string; input: Record<string, Json> };
    target?: "remote" | "selected";
  };
  releaseGate: { lease: string; gate: string };
  observe: { lease?: string };
  materializeSnapshot: { lease: string; key: string };
  nativeRequest: {
    lease: string;
    path: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: Json;
    project?: "secondary";
    target?: "remote";
  };
  productRpc: { lease: string; method: string; params: Json };
  auxiliary: {
    lease: string;
    kind:
      | "password"
      | "setup"
      | "open-setup"
      | "remote-password"
      | "remote-open"
      | "history-sibling";
  };
  writeProjectFiles: { lease: string; files: Record<string, string> };
  restart: { lease: string; target: "native" | "sidecar" };
  scenario: {
    lease: string;
    action:
      | "hold"
      | "release"
      | "freeze"
      | "thaw"
      | "fail"
      | "succeed"
      | "stop";
    sessionID?: string;
  };
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
    queueScript: ["lease", "chunks", "gate", "delay", "tool", "target"],
    releaseGate: ["lease", "gate"],
    observe: ["lease"],
    materializeSnapshot: ["lease", "key"],
    nativeRequest: ["lease", "path", "method", "body", "project", "target"],
    productRpc: ["lease", "method", "params"],
    auxiliary: ["lease", "kind"],
    writeProjectFiles: ["lease", "files"],
    restart: ["lease", "target"],
    scenario: ["lease", "action", "sessionID"],
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
        ![
          "ordinary",
          "composer-pickers",
          "composer-applied",
          "composer-selection",
          "composer-plan",
          "composer-commands",
          "composer-mentions",
          "composer-submission",
          "composer-required",
          "composer-catalog",
          "composer-native-default",
          "composer-long-command",
          "composer-history",
          "composer-shell-failure",
          "contract-composer-missing",
          "contract-composer-none",
          "contract-composer-pending-choice",
          "contract-composer-failed-variant",
          "contract-composer-native-null",
          "messages-native",
          "messages-tools",
          "messages-cooling",
          "messages-files",
          "messages-context",
          "messages-temperature",
          "messages-helper-pages",
          "messages-recovery",
          "messages-recovery-retry",
          "messages-forms",
          "messages-tool-states",
          "messages-priced",
          "isolated",
          "provider-hold",
          "transport-page",
          "transport-deleted-seen",
          "transport-shell",
          "transport-freeze",
          "transport-bootstrap",
          "transport-errors-http",
          "transport-errors-late",
          "transport-enrichment",
          "transport-cooling",
          "transport-restart",
          "contract-core",
          "contract-messages-highlight",
          "contract-messages-facts",
          "contract-messages-metadata",
          "contract-messages-usage3",
          "contract-messages-usage120",
          "contract-messages-usage500",
          "contract-messages-context",
          "contract-messages-collapse",
          "contract-messages-labels",
          "contract-messages-labels-picker",
          "contract-messages-money",
          "contract-messages-window",
          "contract-messages-anchor",
          "contract-messages-diff",
          "contract-messages-disclosures",
          "contract-messages-usage-paging",
          "contract-messages-usage-unknown",
          "contract-messages-usage-queued",
          "contract-messages-usage-priced",
          "contract-messages-usage-unreported",
          "contract-messages-session-cost",
          "contract-messages-reading",
          "contract-messages-public-ui",
          "contract-messages-recorded-files",
          "contract-messages-recorded-tools",
          "contract-messages-clock",
          "contract-reconnect",
          "contract-initial-question",
          "contract-permission-feedback",
          "contract-question-feedback",
          "contract-task-pending",
          "contract-task-background",
          "contract-rpc",
          "fail-start",
          "fail-teardown",
        ].includes(
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
        p.target !== undefined &&
        !["remote", "selected"].includes(String(p.target))
      ) {
        throw new Error("Unknown provider target");
      }
      if (p.tool !== undefined) {
        const tool = object(p.tool);
        keys(tool, ["name", "input"]);
        text(tool.name);
        object(tool.input);
      }
      if (
        p.delay !== undefined &&
        (typeof p.delay !== "number" || p.delay < 0 || p.delay > 16000)
      ) throw new Error("Invalid script cadence");
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
      if (p.target !== undefined && p.target !== "remote") {
        throw new Error("Unknown native target");
      }
      if (p.project !== undefined && p.project !== "secondary") {
        throw new Error("Unknown owned project");
      }
      text(p.path);
      if (
        !/^\/(session(?:\/[^?#]*)?|permission(?:\/[^?#]*)?|question(?:\/[^?#]*)?|provider|command|experimental\/tool\/ids)$/
          .test(p.path)
      ) {
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
    case "auxiliary":
      if (
        ![
          "password",
          "setup",
          "open-setup",
          "remote-password",
          "remote-open",
          "history-sibling",
        ].includes(
          String(p.kind),
        )
      ) throw new Error("Unknown auxiliary composition");
      break;
    case "writeProjectFiles":
      if (!Object.values(object(p.files)).every((s) => typeof s === "string")) {
        throw new Error("Invalid project files");
      }
      break;
    case "restart":
      if (p.target !== "native" && p.target !== "sidecar") {
        throw new Error("Unknown restart target");
      }
      break;
    case "scenario":
      if (
        !["hold", "release", "freeze", "thaw", "fail", "succeed", "stop"]
          .includes(String(p.action))
      ) throw new Error("Unknown scenario action");
      if (p.sessionID !== undefined) {
        text(p.sessionID);
        if (!/^ses_[a-zA-Z0-9]+$/.test(p.sessionID)) {
          throw new Error("Invalid native scenario session");
        }
      }
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
