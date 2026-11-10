// SPDX-License-Identifier: LGPL-3.0-only
/** Private test-process protocol. No product imports or runtime-specific APIs. */
export const FIXTURE_PROTOCOL = 1;
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
/** Profile admission follows the scene's backend, not its contract-* name.
 * New profiles must declare their dependency here; exact native readiness and
 * project/version matching remain owned by the controller and preparation.
 */
export const profiles = {
  ordinary: "v1",
  "contract-typed-forms": "neutral",
  "contract-load-priority": "neutral",
  "contract-load-small": "v1",
  "contract-load-large": "v1",
  "contract-scale-request": "v1",
  "contract-scale-overflow": "neutral",
  "contract-scale-remaining": "neutral",
  "contract-scale-heap": "v1",
  "contract-scale-runtime": "v1",
  "contract-scale-scroll": "v1",
  "contract-scale-core": "neutral",
  "contract-scale-paint": "v1",
  "contract-scale-sessions": "v1",
  "contract-scale-files": "v1",
  "contract-visual-inbox": "neutral",
  "contract-themes": "v1",
  "contract-visual-styles": "neutral",
  "contract-visual-provider-ports": "neutral",
  "contract-visual-native-events": "neutral",
  "contract-menus-inbox": "neutral",
  "contract-menus-content": "neutral",
  "contract-menus-session-actions": "neutral",
  "contract-menus-context": "neutral",
  "contract-menus-dialog": "neutral",
  "contract-menus-hints": "neutral",
  "contract-menus-permission": "neutral",
  "contract-menus-question": "neutral",
  "menus-default": "v1",
  "contract-attention-demand": "neutral",
  "contract-attention-digest": "neutral",
  "contract-attention-lights": "neutral",
  "contract-attention-native": "v1",
  "contract-attention-auto": "v1",
  "contract-attention-remote": "v1",
  "revert-native": "v1",
  "sessions-tasks": "v1",
  "sessions-discovery": "v1",
  "contract-sessions-inbox": "neutral",
  "contract-sessions-panel": "neutral",
  "contract-sessions-memory": "neutral",
  "contract-sessions-membership": "neutral",
  "contract-sessions-hierarchy": "neutral",
  "contract-sessions-axiom": "neutral",
  "contract-sessions-phantom": "neutral",
  "contract-sessions-close": "neutral",
  "contract-sessions-direct": "neutral",
  "contract-sessions-resurrection": "neutral",
  "contract-sessions-unknown": "neutral",
  "contract-sessions-summary": "neutral",
  "contract-sessions-progress": "neutral",
  "contract-sessions-window": "neutral",
  "contract-sessions-catalog": "neutral",
  "contract-sessions-worktrees": "neutral",
  "contract-sessions-merge": "neutral",
  "contract-sessions-tabs": "neutral",
  "composer-pickers": "v1",
  "composer-applied": "v1",
  "composer-selection": "v1",
  "composer-plan": "v1",
  "composer-commands": "v1",
  "composer-mentions": "v1",
  "composer-submission": "v1",
  "composer-required": "v1",
  "composer-catalog": "v1",
  "composer-native-default": "v1",
  "composer-long-command": "v1",
  "composer-history": "v1",
  "composer-shell-failure": "v1",
  "contract-composer-missing": "neutral",
  "contract-composer-none": "neutral",
  "contract-composer-pending-choice": "neutral",
  "contract-composer-failed-variant": "neutral",
  "contract-composer-native-null": "v1",
  "contract-composer-resource-attachments": "neutral",
  "contract-composer-no-resource-attachments": "neutral",
  "messages-native": "v1",
  "messages-tools": "v1",
  "messages-cooling": "v1",
  "messages-files": "v1",
  "messages-context": "v1",
  "messages-temperature": "v1",
  "messages-helper-pages": "v1",
  "messages-recovery": "v1",
  "messages-recovery-retry": "v1",
  "messages-forms": "v1",
  "messages-tool-states": "v1",
  "messages-priced": "v1",
  isolated: "v1",
  "provider-hold": "v1",
  "transport-page": "v1",
  "transport-deleted-seen": "v1",
  "transport-shell": "v1",
  "transport-freeze": "v1",
  "transport-reconnect": "v1",
  "transport-bootstrap": "v1",
  "transport-errors-http": "v1",
  "transport-errors-late": "v1",
  "transport-enrichment": "v1",
  "transport-cooling": "v1",
  "transport-restart": "v1",
  "contract-core": "neutral",
  "contract-messages-highlight": "neutral",
  "contract-messages-facts": "neutral",
  "contract-messages-metadata": "v1",
  "contract-messages-usage3": "neutral",
  "contract-messages-usage120": "neutral",
  "contract-messages-usage500": "neutral",
  "contract-messages-context": "neutral",
  "contract-messages-collapse": "neutral",
  "contract-messages-labels": "neutral",
  "contract-messages-labels-picker": "neutral",
  "contract-messages-money": "neutral",
  "contract-messages-window": "neutral",
  "contract-messages-anchor": "neutral",
  "contract-messages-diff": "neutral",
  "contract-messages-disclosures": "neutral",
  "contract-messages-usage-paging": "neutral",
  "contract-messages-usage-unknown": "neutral",
  "contract-messages-usage-queued": "neutral",
  "contract-messages-usage-priced": "neutral",
  "contract-messages-usage-unreported": "neutral",
  "contract-messages-session-cost": "neutral",
  "contract-messages-reading": "neutral",
  "contract-messages-public-ui": "neutral",
  "contract-messages-recorded-files": "v1",
  "contract-messages-recorded-tools": "v1",
  "contract-messages-clock": "neutral",
  "contract-reconnect": "neutral",
  "contract-initial-question": "neutral",
  "contract-permission-feedback": "neutral",
  "contract-question-feedback": "neutral",
  "contract-task-pending": "neutral",
  "contract-task-background": "neutral",
  "contract-rpc": "neutral",
  "fail-start": "v1",
  "fail-teardown": "v1",
} as const;
export type Profile = keyof typeof profiles;
export interface Commands {
  start: { profile: Profile; version: string };
  beginTest: { identity: string };
  endTest: { lease: string };
  queueScript: {
    lease: string;
    chunks: string[];
    reasoning?: string[];
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
      | "disconnect"
      | "fail"
      | "succeed"
      | "stop";
    sessionID?: string;
    target?: "revert" | "unrevert" | "backgrounds" | "summarize" | "tabs-pin";
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
    queueScript: [
      "lease",
      "chunks",
      "reasoning",
      "gate",
      "delay",
      "tool",
      "target",
    ],
    releaseGate: ["lease", "gate"],
    observe: ["lease"],
    materializeSnapshot: ["lease", "key"],
    nativeRequest: ["lease", "path", "method", "body", "project", "target"],
    productRpc: ["lease", "method", "params"],
    auxiliary: ["lease", "kind"],
    writeProjectFiles: ["lease", "files"],
    restart: ["lease", "target"],
    scenario: ["lease", "action", "sessionID", "target"],
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
        typeof p.profile !== "string" || !Object.hasOwn(profiles, p.profile)
      ) {
        throw new Error("Unknown scenario profile");
      }
      if (
        typeof p.version !== "string" || !/^[12]\.\d+\.\d+$/.test(p.version)
      ) {
        throw new Error("Invalid version");
      }
      break;
    case "beginTest":
      text(p.identity);
      break;
    case "queueScript":
      if (
        p.reasoning !== undefined &&
        (!Array.isArray(p.reasoning) ||
          !p.reasoning.every((s) => typeof s === "string"))
      ) throw new Error("Invalid script reasoning");
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
        (typeof p.delay !== "number" || p.delay < 0 || p.delay > 20000)
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
        !/^\/(session(?:\/[^?#]*)?|permission(?:\/[^?#]*)?|question(?:\/[^?#]*)?|provider|model|command|experimental\/tool\/ids)$/
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
        p.target !== undefined &&
        !["revert", "unrevert", "backgrounds", "summarize", "tabs-pin"]
          .includes(
            String(p.target),
          )
      ) throw new Error("Unknown scenario target");
      if (
        ![
          "hold",
          "release",
          "freeze",
          "thaw",
          "disconnect",
          "fail",
          "succeed",
          "stop",
        ]
          .includes(String(p.action))
      ) throw new Error("Unknown scenario action");
      if (p.sessionID !== undefined) {
        text(p.sessionID);
        if (!/^(?:ses_[a-zA-Z0-9]+|tstv1-[a-zA-Z0-9-]+)$/.test(p.sessionID)) {
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
